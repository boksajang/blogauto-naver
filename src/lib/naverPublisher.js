const fs = require("node:fs");
const path = require("node:path");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionExpiredError(message = "네이버 세션이 만료되어 사용자 로그인이 필요합니다.") {
  const error = new Error(message);
  error.code = "SESSION_EXPIRED";
  return error;
}

function securityCheckTimeoutError(message = "네이버 보안 확인 또는 캡챠 완료를 제한 시간 안에 확인하지 못했습니다.") {
  const error = new Error(message);
  error.code = "SECURITY_CHECK_TIMEOUT";
  return error;
}

function authoringRestartRequiredError(stage = "글 작성") {
  const error = new Error(`${stage} 중 재로그인은 완료됐지만 작성 중이던 임시글을 복구하지 못해 처음부터 다시 작성합니다.`);
  error.code = "NAVER_AUTHORING_RESTART_REQUIRED";
  return error;
}

async function gotoResilient(page, url, options = {}) {
  try {
    await page.goto(url, options);
    return true;
  } catch (error) {
    const message = String(error.message || "");
    if (/net::ERR_ABORTED|frame was detached|Navigation failed because page was closed/i.test(message)) {
      if (!(page.isClosed && page.isClosed())) {
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      }
      await sleep(1000);
      return false;
    }
    throw error;
  }
}

function activePage(context, fallbackPage) {
  const pages = context.pages().filter((item) => !item.isClosed());
  return pages.find((item) => item.url() && item.url() !== "about:blank") || pages[0] || fallbackPage;
}

function resolveBlogId(options = {}) {
  return String(options.blogId || options.naverBlogId || "").trim();
}

function postWriteUrlFor(options = {}) {
  const blogId = resolveBlogId(options);
  return blogId
    ? `https://blog.naver.com/${encodeURIComponent(blogId)}/postwrite`
    : "https://naver.com";
}

function markChromeProfileClean(browserProfileDir) {
  const updateJsonFile = (filePath, mutate) => {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      const data = raw ? JSON.parse(raw) : {};
      mutate(data);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // Best effort only. Chrome can still launch if the profile file is locked or malformed.
    }
  };

  updateJsonFile(path.join(browserProfileDir, "Local State"), (data) => {
    data.profile = data.profile || {};
    data.profile.exit_type = "Normal";
    data.profile.exited_cleanly = true;
  });

  try {
    const entries = fs.existsSync(browserProfileDir) ? fs.readdirSync(browserProfileDir, { withFileTypes: true }) : [];
    const profileDirs = entries
      .filter((entry) => entry.isDirectory() && /^(Default|Profile \d+)$/i.test(entry.name))
      .map((entry) => path.join(browserProfileDir, entry.name));
    for (const profileDir of profileDirs) {
      updateJsonFile(path.join(profileDir, "Preferences"), (data) => {
        data.profile = data.profile || {};
        data.profile.exit_type = "Normal";
        data.profile.exited_cleanly = true;
      });
    }
  } catch {
    // Best effort only.
  }
}

function chromeLaunchOptions({ slowMo, viewport }) {
  return {
    channel: "chrome",
    chromiumSandbox: true,
    headless: false,
    slowMo,
    viewport,
    args: [
      "--hide-crash-restore-bubble",
      "--disable-session-crashed-bubble",
      "--no-first-run"
    ]
  };
}

async function gotoResilientInContext(context, page, url, options = {}) {
  let currentPage = activePage(context, page);
  await gotoResilient(currentPage, url, options);
  return activePage(context, currentPage);
}

async function safeClickLocator(_page, locator, _log = () => {}, _label = "요소") {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ delay: 120, timeout: 5000 });
  } catch (error) {
    if (/se-popup|popup|intercepts pointer events/i.test(error.message || "")) {
      const dismissed = await dismissExistingDraftDialog(_page, _log);
      if (dismissed) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.click({ delay: 120, timeout: 5000 });
      } else if (/se-selection/i.test(error.message || "")) {
        await locator.click({ delay: 120, timeout: 5000, force: true });
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }
  await sleep(160 + Math.floor(Math.random() * 120));
}

async function humanType(page, selector, text) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 15000 });
  await safeClickLocator(page, locator);
  await page.keyboard.type(String(text || ""), {
    delay: 75 + Math.floor(Math.random() * 45)
  });
}

async function humanClear(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 15000 });
  await safeClickLocator(page, locator);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
}

async function findVisibleLocator(page, selectors, timeout = 20000) {
  const deadline = Date.now() + timeout;
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];

  while (Date.now() < deadline) {
    for (const selector of selectorList) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (await item.isVisible().catch(() => false)) {
          return item;
        }
      }
    }

    for (const frame of page.frames()) {
      for (const selector of selectorList) {
        const locator = frame.locator(selector);
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const item = locator.nth(index);
          if (await item.isVisible().catch(() => false)) {
            return item;
          }
        }
      }
    }

    await sleep(300);
  }

  throw new Error(`입력 영역을 찾을 수 없습니다: ${selectorList.join(", ")}`);
}

async function collectVisibleLocators(page, selectors) {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];
  const items = [];

  for (const selector of selectorList.filter(Boolean)) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) {
        items.push(item);
      }
    }
  }

  for (const frame of page.frames()) {
    for (const selector of selectorList.filter(Boolean)) {
      const locator = frame.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (await item.isVisible().catch(() => false)) {
          items.push(item);
        }
      }
    }
  }

  return items;
}

async function findLowerVisibleLocator(page, selectors, timeout = 20000, filter = null) {
  const deadline = Date.now() + timeout;
  let best = null;

  while (Date.now() < deadline) {
    const candidates = await collectVisibleLocators(page, selectors);
    for (const item of candidates) {
      const box = await item.boundingBox().catch(() => null);
      if (!box || box.width < 30 || box.height < 12) continue;
      if (filter && !(await filter(item).catch(() => false))) continue;
      if (!best || box.y > best.box.y) {
        best = { item, box };
      }
    }

    if (best) return best.item;
    await sleep(300);
  }

  throw new Error(`본문 입력 영역을 찾을 수 없습니다: ${(Array.isArray(selectors) ? selectors : [selectors]).join(", ")}`);
}

async function findTopBodyLocator(page, selectors, afterBox, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let best = null;
  const minY = afterBox ? afterBox.y + afterBox.height - 4 : 0;

  while (Date.now() < deadline) {
    const candidates = await collectVisibleLocators(page, selectors);
    for (const item of candidates) {
      const box = await item.boundingBox().catch(() => null);
      if (!box || box.width < 30 || box.height < 12 || box.y < minY) continue;
      if (!best || box.y < best.box.y) {
        best = { item, box };
      }
    }

    if (best) return best.item;
    await sleep(300);
  }

  throw new Error(`본문 최상단 입력 영역을 찾을 수 없습니다: ${(Array.isArray(selectors) ? selectors : [selectors]).join(", ")}`);
}

async function humanTypeAny(page, selectors, text) {
  const locator = await findVisibleLocator(page, selectors);
  await typeIntoLocator(page, locator, text);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function typeIntoLocator(page, locator, text, log = () => {}, label = "입력") {
  await safeClickLocator(page, locator);
  const value = String(text || "");
  log(`${label} 시작`);
  await withTimeout(
    page.keyboard.type(value, {
      delay: 75 + Math.floor(Math.random() * 45)
    }),
    Math.max(15000, value.length * 250),
    `${label} 제한 시간을 초과했습니다.`
  );
  log(`${label} 완료`);
}

async function typeAtCurrentCursor(page, text, log = () => {}, label = "입력") {
  const value = String(text || "");
  log(`${label} 시작`);
  await withTimeout(
    page.keyboard.type(value, {
      delay: 75 + Math.floor(Math.random() * 45)
    }),
    Math.max(15000, value.length * 250),
    `${label} 제한 시간을 초과했습니다.`
  );
  log(`${label} 완료`);
}

function splitKoreanSentences(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return [];
  return value
    .split(/(?<=[.!?。！？]|(?:다|요|죠|임|음|함|됨)\.)(?=\s+)/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function typeBodyParagraph(page, text, options, log) {
  const shouldBreakSentences = options.breakSentencesInBody !== false;
  if (!shouldBreakSentences) {
    await typeAtCurrentCursor(page, text, log, "본문 문단 입력");
    return;
  }

  const sentences = splitKoreanSentences(text);
  if (sentences.length <= 1) {
    await typeAtCurrentCursor(page, text, log, "본문 문단 입력");
    return;
  }

  log("본문 문장 줄바꿈 입력 시작");
  for (const [index, sentence] of sentences.entries()) {
    await typeAtCurrentCursor(page, sentence, log, "본문 문장 입력");
    if (index < sentences.length - 1) {
      await page.keyboard.press("Enter");
    }
  }
  log("본문 문장 줄바꿈 입력 완료");
}

async function clickFirstVisible(page, selector, label, log) {
  const selectorList = Array.isArray(selector) ? selector.filter(Boolean) : [selector].filter(Boolean);
  const deadline = Date.now() + 15000;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const itemSelector of selectorList) {
      const locator = page.locator(itemSelector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (await item.isVisible().catch(() => false)) {
          try {
            await safeClickLocator(page, item, log, label);
            return true;
          } catch (error) {
            lastError = error;
          }
        }
      }
    }
    await sleep(500);
  }

  const detail = lastError ? ` (${lastError.message.split("\n")[0]})` : "";
  log(`${label}을 찾거나 클릭할 수 없습니다.${detail}`, "warn");
  return false;
}

async function clickLocatorResilient(page, locator, log, label) {
  try {
    await safeClickLocator(page, locator, log, label);
    return true;
  } catch (error) {
    if (/intercepts pointer events|Timeout/i.test(error.message || "")) {
      await locator.click({ delay: 120, timeout: 5000, force: true });
      await sleep(300);
      return true;
    }
    throw error;
  }
}

async function clickVisibleText(page, text, timeout = 10000) {
  const deadline = Date.now() + timeout;
  const target = String(text || "").trim();
  if (!target) return false;

  while (Date.now() < deadline) {
    const pageLocator = page.getByText(target, { exact: true }).first();
    if (await pageLocator.isVisible().catch(() => false)) {
      await safeClickLocator(page, pageLocator);
      return true;
    }

    for (const frame of page.frames()) {
      const frameLocator = frame.getByText(target, { exact: true }).first();
      if (await frameLocator.isVisible().catch(() => false)) {
        await safeClickLocator(page, frameLocator);
        return true;
      }
    }

    await sleep(300);
  }

  return false;
}

async function clickVisibleMenuText(page, text, timeout = 5000) {
  const deadline = Date.now() + timeout;
  const target = String(text || "").trim();
  if (!target) return false;

  const clickInRoot = async (root) => root.evaluate((label) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const containers = Array.from(document.querySelectorAll([
      "[role='menu']",
      "[role='listbox']",
      "[class*='dropdown']",
      "[class*='Dropdown']",
      "[class*='layer']",
      "[class*='Layer']",
      "[class*='popup']",
      "[class*='Popup']",
      "[class*='toolbar']",
      "[class*='Toolbar']"
    ].join(","))).filter(visible);
    const roots = containers.length ? containers : [document.body];
    for (const container of roots) {
      const controls = Array.from(container.querySelectorAll([
        "button",
        "a",
        "li",
        "[role='button']",
        "[role='menuitem']",
        "[role='option']",
        "span",
        "div"
      ].join(",")));
      const match = controls
        .filter(visible)
        .map((element) => ({
          element,
          text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim()
        }))
        .find((item) => item.text === label || item.text.includes(label));
      if (match) {
        match.element.click();
        return true;
      }
    }
    return false;
  }, target).catch(() => false);

  while (Date.now() < deadline) {
    if (await clickInRoot(page)) return true;
    for (const frame of page.frames()) {
      if (await clickInRoot(frame)) return true;
    }
    await sleep(250);
  }

  return false;
}

function boxOverlapRatio(a, b) {
  if (!a || !b) return 0;
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlapArea = xOverlap * yOverlap;
  const area = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  return overlapArea / area;
}

async function clickVisibleTextOutside(page, text, excludedBox, timeout = 10000) {
  const deadline = Date.now() + timeout;
  const target = String(text || "").trim();
  if (!target) return false;

  while (Date.now() < deadline) {
    const roots = [page, ...page.frames()];
    for (const root of roots) {
      const locator = root.getByText(target, { exact: true });
      const count = await locator.count().catch(() => 0);
      const candidates = [];
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (!await item.isVisible().catch(() => false)) continue;
        const box = await item.boundingBox().catch(() => null);
        if (!box || boxOverlapRatio(box, excludedBox) > 0.5) continue;
        candidates.push({ item, box });
      }

      candidates.sort((a, b) => b.box.y - a.box.y);
      if (candidates[0]) {
        await safeClickLocator(page, candidates[0].item);
        return true;
      }
    }

    await sleep(300);
  }

  return false;
}

function parseDomNotes(domNotes) {
  const text = String(domNotes || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function quotedTextSelector(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function visibleCount(page, selector) {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      visible += 1;
    }
  }
  return visible;
}

async function readBodyText(page) {
  return page.locator("body").innerText({ timeout: 1200 }).catch(() => "");
}

async function hasVisibleEditorPopup(page) {
  const popupSelector = ".se-popup-dim, .se-popup-alert, [data-group='popupLayer'], [data-name*='se-popup-alert']";
  if (await visibleCount(page, popupSelector).catch(() => 0)) {
    return true;
  }
  for (const frame of page.frames()) {
    const locator = frame.locator(popupSelector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) {
        return true;
      }
    }
  }
  return false;
}

async function clickExactPopupButton(page, text) {
  const target = String(text || "").trim();
  const clickInRoot = async (root) => root.evaluate((buttonText) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const containers = Array.from(document.querySelectorAll([
      ".se-popup-alert",
      "[data-group='popupLayer']",
      "[data-name*='se-popup-alert']",
      "[role='dialog']",
      "[class*='layer']",
      "[class*='popup']"
    ].join(","))).filter(visible);
    const roots = containers.length ? containers : [document.body];
    for (const container of roots) {
      const controls = Array.from(container.querySelectorAll("button, a"));
      const match = controls.find((control) => {
        if (!visible(control)) return false;
        const labels = [
          control.innerText,
          control.textContent,
          control.getAttribute("aria-label"),
          control.getAttribute("title"),
          control.getAttribute("value")
        ].map((value) => String(value || "").trim()).filter(Boolean);
        return labels.some((label) => label === buttonText);
      });
      if (match) {
        match.click();
        return true;
      }
    }
    return false;
  }, target).catch(() => false);

  if (await clickInRoot(page)) return true;
  for (const frame of page.frames()) {
    if (await clickInRoot(frame)) return true;
  }
  return false;
}

function looksLikeSecurityCheck(url, bodyText) {
  const text = String(bodyText || "");
  const href = String(url || "");
  const securityHostOrPath = /(?:^|\/\/)nid\.naver\.com/i.test(href)
    || /captcha|protect|security|verification|auth/i.test(href);
  if (!securityHostOrPath) return false;
  return /captcha|\uC790\uB3D9\s*\uC785\uB825|\uBCF4\uC548\s*\uD655\uC778|\uC0AC\uB78C\uC785\uB2C8\uAE4C|\uB85C\uBD07|\uBE44\uC815\uC0C1\uC801|\uBCF8\uC778\s*\uD655\uC778|\uC778\uC99D\uBC88\uD638/i.test(`${href}\n${text}`);
}

async function waitForSecurityCheckComplete(page, selectors, log, options = {}) {
  const timeout = Math.max(1, Number(options.securityCheckTimeout) || 10 * 60 * 1000);
  const pollInterval = Math.max(0, Number(options.securityCheckPollInterval) || 1000);
  const stableReadsRequired = Math.max(1, Number(options.securityCheckStableReads) || 2);
  const deadline = Date.now() + timeout;
  let availableReads = 0;

  while (Date.now() < deadline) {
    const state = await detectLoginState(page, selectors);
    if (state.state === "security_check") {
      availableReads = 0;
    } else if (state.state === "login_required") {
      log("네이버 보안 확인 이후 로그인 화면으로 이동했습니다.", "warn");
      return state;
    } else {
      availableReads += 1;
      if (availableReads >= stableReadsRequired) {
        log("네이버 보안 확인 완료를 확인했습니다. 중단한 작업을 이어갑니다.");
        return state;
      }
    }
    await sleep(pollInterval);
  }

  throw securityCheckTimeoutError();
}

async function waitForLoginComplete(page, log, timeout = 10 * 60 * 1000, selectors = {}, pollInterval = 1000) {
  const deadline = Date.now() + timeout;
  let securityLogged = false;
  let loginLogged = false;
  let availableReads = 0;

  while (Date.now() < deadline) {
    const state = await detectLoginState(page, selectors);

    if (state.state === "security_check") {
      availableReads = 0;
      if (!securityLogged) {
        log("네이버 보안 확인이 표시되었습니다. 브라우저에서 사용자가 직접 완료하면 자동으로 이어갑니다.", "warn");
        securityLogged = true;
      }
    } else if (state.state === "login_required") {
      availableReads = 0;
      if (!loginLogged) {
        log("네이버 로그인 완료를 기다리는 중입니다.");
        loginLogged = true;
      }
    } else {
      availableReads += 1;
      if (availableReads >= 2) {
        log("네이버 로그인 완료를 확인했습니다.");
        return state;
      }
    }

    await sleep(Math.max(0, Number(pollInterval) || 0));
  }

  throw new Error("네이버 로그인 또는 보안 확인 완료를 제한 시간 안에 확인하지 못했습니다.");
}

async function detectLoginState(page, selectors = {}) {
  const url = page.url();
  const bodyText = await readBodyText(page);
  const idSelector = selectors.idInput || "#id";
  const passwordSelector = selectors.passwordInput || "#pw";
  const loginInputs = await visibleCount(page, `${idSelector}, ${passwordSelector}`);
  if (looksLikeSecurityCheck(url, bodyText)) {
    return { state: "security_check", url };
  }
  if (/nid\.naver\.com\/nidlogin/i.test(url) || loginInputs > 0) {
    return { state: "login_required", url };
  }
  return { state: "available", url };
}

async function assertNaverSessionActive(page, selectors, log, stage = "작업", options = {}) {
  let state = await detectLoginState(page, selectors);
  let sessionRecovered = false;
  let loginWasRequired = false;
  if (state.state === "security_check") {
    log(`${stage} 중 네이버 보안 확인/캡챠 화면으로 이동했습니다. 브라우저에서 완료하면 작업을 이어갑니다.`, "warn");
    state = await waitForSecurityCheckComplete(page, selectors, log, options);
    sessionRecovered = true;
  }
  if (state.state === "login_required") {
    if (options.recoverSessionDuringWork === true) {
      loginWasRequired = true;
      log(`${stage} 중 네이버 로그인이 다시 필요합니다. 현재 창에서 아이디와 비밀번호를 직접 입력하면 작업을 이어갑니다.`, "warn");
      const recoveryOptions = { ...options, failOnLoginRequired: false };
      await completeLoginIfNeeded(page, selectors, recoveryOptions, log);
      state = await detectLoginState(page, selectors);
      sessionRecovered = true;
    }
  }
  if (state.state === "login_required") {
    log(`${stage} 중 네이버 로그인 화면으로 이동했습니다. 계정 세션을 만료 처리합니다.`, "warn");
    throw sessionExpiredError("네이버 로그인 화면으로 이동해 계정 세션이 만료되었습니다.");
  }
  if (sessionRecovered && options.recoverSessionDuringWork === true) {
    const restored = await restorePostWriteAfterSessionRecovery(
      page,
      selectors,
      { ...options, startFreshAfterRecovery: loginWasRequired },
      log,
      stage
    );
    if (options.restartAuthoringWhenDraftMissing !== false
      && (loginWasRequired || restored.navigated || !restored.hasDraft)) {
      throw authoringRestartRequiredError(stage);
    }
  }
}

async function verifyPostWriteSession(context, page, selectors, options, postWriteUrl, log) {
  let currentPage = await gotoResilientInContext(context, page, postWriteUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(1200);
    let state = await detectLoginState(currentPage, selectors);
    if (state.state === "security_check") {
      log("블로그 글쓰기 URL 진입 중 네이버 보안 확인이 표시되었습니다. 완료하면 자동으로 재확인합니다.", "warn");
      state = await waitForSecurityCheckComplete(currentPage, selectors, log, options);
      currentPage = activePage(context, currentPage);
    }
    if (state.state === "login_required") {
      if (options.interactiveLogin) {
        await completeLoginIfNeeded(currentPage, selectors, options, log);
        currentPage = activePage(context, currentPage);
        currentPage = await gotoResilientInContext(context, currentPage, postWriteUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000
        });
        continue;
      }
      return { status: "expired", reason: "login_required", url: state.url, page: currentPage };
    }
    if (!matchesTargetPostWriteUrl(currentPage.url(), postWriteUrl)) {
      currentPage = await gotoResilientInContext(context, currentPage, postWriteUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      continue;
    }

    log("블로그 글쓰기 URL 접근과 로그인 세션을 확인했습니다.");
    return { status: "valid", reason: "postwrite_session_available", url: currentPage.url(), page: currentPage };
  }
  throw new Error(`네이버 보안 확인 후 블로그 글쓰기 URL로 복귀하지 못했습니다. 현재 URL: ${currentPage.url()}`);
}

async function verifyPostWriteEditorSession(context, page, selectors, options, postWriteUrl, log) {
  const result = await verifyPostWriteSession(context, page, selectors, options, postWriteUrl, log);
  if (result.status !== "valid") return result;
  const currentPage = result.page || page;
  log("블로그 글쓰기 편집기 화면 확인을 시작합니다.");
  await waitForPostWriteTitle(
    currentPage,
    selectors,
    options,
    postWriteUrl,
    log,
    options.editorCheckTimeout || 120000
  );
  return {
    ...result,
    reason: "postwrite_editor_available",
    page: currentPage
  };
}

async function verifyOpenNaverSession(options) {
  const log = options.log || (() => {});
  const context = options.preparedContext || options.context;
  if (!context) throw new Error("Open Naver browser context is required.");
  const selectors = {
    idInput: "#id",
    passwordInput: "#pw",
    titleInput: "textarea[placeholder*='?쒕ぉ'], input[placeholder*='?쒕ぉ'], .se-title-text [contenteditable='true'], .se-title [contenteditable='true'], .se-title-text textarea, .se-title-text input",
    ...parseDomNotes(options.domNotes)
  };
  const postWriteUrl = postWriteUrlFor(options);
  let page = activePostWritePage(context, options.preparedPage || options.page || null, postWriteUrl);
  if (!page) page = await context.newPage();
  let loginState = await detectLoginState(page, selectors);
  if (loginState.state === "security_check") {
    await completeLoginIfNeeded(page, selectors, options, log);
    page = activePostWritePage(context, page, postWriteUrl);
    loginState = await detectLoginState(page, selectors);
  }
  if (loginState.state === "login_required") {
    if (options.interactiveLogin) {
      await completeLoginIfNeeded(page, selectors, options, log);
      page = activePostWritePage(context, page, postWriteUrl);
    } else {
    return { status: "expired", reason: "login_required", url: loginState.url, page };
    }
  }
  if (!matchesTargetPostWriteUrl(page.url(), postWriteUrl)) {
    page = await gotoResilientInContext(context, page, postWriteUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
  }
  await waitForPostWriteTitle(
    page,
    selectors,
    options,
    postWriteUrl,
    log,
    options.editorCheckTimeout || 60000
  );
  return {
    status: "valid",
    reason: "open_postwrite_editor_available",
    url: page.url(),
    page,
    preparedSession: {
      context,
      page,
      browserProfileDir: options.browserProfileDir || "",
      postWriteUrl
    }
  };
}

async function prepareNaverPostWrite(options) {
  const log = options.log || (() => {});
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    throw new Error("playwright-core가 설치되어 있지 않아 Naver 브라우저 자동화를 실행할 수 없습니다.");
  }

  const selectors = {
    idInput: "#id",
    passwordInput: "#pw",
    titleInput: "textarea[placeholder*='제목'], input[placeholder*='제목'], .se-title-text [contenteditable='true'], .se-title [contenteditable='true'], .se-title-text textarea, .se-title-text input",
    ...parseDomNotes(options.domNotes)
  };
  const browserProfileDir = options.browserProfileDir
    || path.join(options.runtimeRoot || process.cwd(), "browser-profile");
  fs.mkdirSync(browserProfileDir, { recursive: true });
  markChromeProfileClean(browserProfileDir);

  const context = await chromium.launchPersistentContext(browserProfileDir, chromeLaunchOptions({
    slowMo: 80,
    viewport: { width: 1366, height: 900 }
  }));

  try {
    let page = context.pages()[0] || await context.newPage();
    await gotoResilient(page, "https://naver.com", { waitUntil: "domcontentloaded", timeout: 45000 });
    page = activePage(context, page);
    log("naver.com 접속 완료");

    const postWriteUrl = postWriteUrlFor(options);
    log(`블로그 글쓰기 목표 URL: ${postWriteUrl}`);
    page = await gotoResilientInContext(context, page, postWriteUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    log("블로그 글쓰기 URL 접근을 시도했습니다.");

    const didLogin = await completeLoginIfNeeded(page, selectors, options, log);
    if (didLogin) {
      page = await gotoResilientInContext(context, page, postWriteUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      log("로그인 후 블로그 글쓰기 URL로 다시 접근했습니다.");
    } else {
      log("기존 브라우저 세션을 사용합니다.");
    }

    await waitForPostWriteTitle(page, selectors, options, postWriteUrl, log);
    log("블로그 글쓰기 화면 로드를 확인했습니다.");
    return { context, page, browserProfileDir, postWriteUrl };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function completeLoginIfNeeded(page, selectors, options, log) {
  let state = await detectLoginState(page, selectors);
  if (state.state === "security_check") {
    log("네이버 보안 확인이 표시되었습니다. 브라우저에서 사용자가 직접 완료하면 자동으로 이어갑니다.", "warn");
    state = await waitForSecurityCheckComplete(page, selectors, log, options);
  }

  if (state.state === "login_required") {
    log("네이버 로그인 창에서 아이디와 비밀번호를 직접 입력해 주세요. 로그인 완료까지 현재 창을 유지합니다.", "warn");
    await waitForLoginComplete(page, log, options.securityCheckTimeout || 10 * 60 * 1000, selectors);
    return true;
  }

  return false;
}

async function dismissExistingDraftDialog(page, log) {
  const bodyText = await readBodyText(page);
  const hasDraftText = /작성\s*중|작성하던|임시\s*저장|이어서|불러오|저장된\s*글/i.test(bodyText);
  const hasPopup = await hasVisibleEditorPopup(page);
  if (!hasDraftText && !hasPopup) {
    return false;
  }

  const cancelled = await clickExactPopupButton(page, "취소");
  if (!cancelled) {
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(300);
    return !await hasVisibleEditorPopup(page);
  }

  log("기존 작성 실패/임시글 안내를 취소하고 새 글 작성을 계속합니다.");
  await sleep(800);
  return true;
}

async function resumeExistingDraftDialog(page, log) {
  const bodyText = await readBodyText(page);
  const hasDraftText = /작성\s*중|작성하던|임시\s*저장|이어서|불러오|저장된\s*글/i.test(bodyText);
  const hasPopup = await hasVisibleEditorPopup(page);
  if (!hasDraftText && !hasPopup) {
    return false;
  }

  const resumeLabels = ["이어서 작성", "이어서 쓰기", "이어쓰기", "불러오기"];
  for (const label of resumeLabels) {
    if (await clickExactPopupButton(page, label)) {
      log("재로그인 후 네이버의 기존 작성글을 불러와 이어서 작성합니다.");
      await sleep(1000);
      return true;
    }
  }

  return false;
}

async function selectNativeCategory(page, category) {
  const roots = [page, ...page.frames()];
  for (const root of roots) {
    const selects = root.locator("select");
    const count = await selects.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const select = selects.nth(index);
      if (!await select.isVisible().catch(() => false)) continue;
      const value = await select.evaluate((element, label) => {
        const option = Array.from(element.options || [])
          .find((item) => String(item.textContent || "").trim() === label);
        return option ? option.value : null;
      }, category).catch(() => null);
      if (value !== null && value !== undefined) {
        await select.selectOption(value);
        return true;
      }
    }
  }
  return false;
}

async function selectCategory(page, selectors, category, log) {
  const target = String(category || "").trim();
  if (!target) return false;

  if (await selectNativeCategory(page, target)) {
    log("카테고리를 선택했습니다.");
    return true;
  }

  const escapedCategory = quotedTextSelector(target);
  const dropdownTriggers = [
    selectors.categoryDropdown,
    selectors.categoryButton,
    "button[aria-haspopup='listbox']",
    "[role='combobox']",
    "[aria-haspopup='listbox']",
    "[class*='dropdown']",
    "[class*='Dropdown']",
    "[class*='select']",
    "[class*='Select']",
    "[class*='category']",
    "[class*='Category']",
    `button:has-text("${escapedCategory}")`,
    `[role='button']:has-text("${escapedCategory}")`,
    "button:has-text('분류')",
    "button:has-text('선택')",
    "button:has-text('카테고리')",
    "text=카테고리"
  ].filter(Boolean);

  for (const triggerSelector of dropdownTriggers) {
    const trigger = await findVisibleLocator(page, triggerSelector, 1800).catch(() => null);
    if (!trigger) continue;
    const triggerBox = await trigger.boundingBox().catch(() => null);
    await safeClickLocator(page, trigger, log, "카테고리 드롭다운");
    await sleep(500);
    if (await clickVisibleTextOutside(page, target, triggerBox, 3500)) {
      log("카테고리를 선택했습니다.");
      return true;
    }
  }

  log(`카테고리 '${target}' 항목을 찾지 못했습니다. 현재 선택된 카테고리를 유지합니다.`, "warn");
  return false;
}

function titleSelectors(selectors) {
  return [
    selectors.titleInput,
    "textarea[placeholder*='제목']",
    "input[placeholder*='제목']",
    "[aria-label*='제목']",
    "[data-placeholder*='제목']",
    ".se-documentTitle [contenteditable='true']",
    ".se-documentTitle textarea",
    ".se-documentTitle input",
    ".se-title-text [contenteditable='true']",
    ".se-title [contenteditable='true']",
    ".se-title-text .se-text-paragraph",
    ".se-title-text p",
    ".se-title .se-text-paragraph",
    ".se-title p",
    "[class*='title'] [contenteditable='true']",
    "[class*='Title'] [contenteditable='true']",
    ".se-title-text textarea",
    ".se-title-text input"
  ].filter(Boolean);
}

function editorReadySelectors() {
  return [
    ".se-main-container",
    ".se-editor",
    ".se-content",
    ".se-canvas",
    ".se-component",
    ".se-section-text",
    "[contenteditable='true']"
  ];
}

async function isEditableSurfaceCandidate(locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box || box.width < 180 || box.height < 18) return false;
  return locator.evaluate((node) => {
    const blocked = node.closest([
      "[class*='toolbar']",
      "[class*='Toolbar']",
      "[class*='popup']",
      "[class*='Popup']",
      "[class*='layer']",
      "[class*='Layer']",
      "[class*='comment']",
      "[class*='Comment']",
      "[class*='menu']",
      "[class*='Menu']"
    ].join(","));
    if (blocked) return false;
    const text = [
      node.getAttribute("class"),
      node.getAttribute("placeholder"),
      node.getAttribute("aria-label"),
      node.getAttribute("data-placeholder"),
      node.parentElement?.getAttribute("class"),
      node.closest("[class]")?.getAttribute("class")
    ].join(" ").toLowerCase();
    return /title|se-title|documenttitle|제목/.test(text)
      || node.getAttribute("contenteditable") === "true";
  }).catch(() => false);
}

async function findFallbackTitleLocator(page) {
  const candidates = await collectVisibleLocators(page, [
    ".se-title-text .se-text-paragraph",
    ".se-title-text p",
    ".se-title .se-text-paragraph",
    ".se-title p",
    "[contenteditable='true']",
    "textarea",
    "input[type='text']"
  ]);
  const usable = [];
  for (const item of candidates) {
    if (!await isEditableSurfaceCandidate(item)) continue;
    const box = await item.boundingBox().catch(() => null);
    if (box) usable.push({ item, box });
  }
  usable.sort((a, b) => a.box.y - b.box.y);
  return usable[0]?.item || null;
}

function debugRootFor(options = {}) {
  if (options.runtimeRoot) return options.runtimeRoot;
  if (options.browserProfileDir) {
    return path.resolve(options.browserProfileDir, "..", "..");
  }
  return process.cwd();
}

async function collectEditorDiagnostics(page) {
  const roots = [page, ...page.frames()];
  const frames = [];
  for (const root of roots) {
    const frameInfo = await root.evaluate(() => {
      const summarize = (node) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          className: node.getAttribute("class") || "",
          id: node.getAttribute("id") || "",
          placeholder: node.getAttribute("placeholder") || "",
          ariaLabel: node.getAttribute("aria-label") || "",
          dataPlaceholder: node.getAttribute("data-placeholder") || "",
          contenteditable: node.getAttribute("contenteditable") || "",
          text: String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
          box: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      };
      const selector = [
        "textarea",
        "input",
        "[contenteditable='true']",
        ".se-title-text",
        ".se-title",
        ".se-documentTitle",
        ".se-main-container",
        ".se-editor",
        ".se-content",
        ".se-canvas"
      ].join(",");
      return {
        url: location.href,
        title: document.title,
        bodyText: String(document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2000),
        candidates: Array.from(document.querySelectorAll(selector)).slice(0, 80).map(summarize)
      };
    }).catch((error) => ({
      url: root.url?.() || "",
      error: error.message
    }));
    frames.push(frameInfo);
  }
  return {
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    frames
  };
}

async function saveEditorDiagnostics(page, options, log) {
  try {
    const root = debugRootFor(options);
    fs.mkdirSync(root, { recursive: true });
    const filePath = path.join(root, `naver-editor-debug-${Date.now()}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(await collectEditorDiagnostics(page), null, 2)}\n`, "utf8");
    log(`Naver Editor DOM 진단 파일을 저장했습니다: ${filePath}`, "warn");
  } catch (error) {
    log(`Naver Editor DOM 진단 파일 저장을 건너뜁니다: ${error.message}`, "warn");
  }
}

function looksLikePostWriteUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname === "blog.naver.com"
      && /^\/[^/]+\/postwrite\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizePostWriteUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return `${parsed.hostname.toLowerCase()}${decodeURIComponent(parsed.pathname).replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return "";
  }
}

function matchesTargetPostWriteUrl(url, targetUrl) {
  return looksLikePostWriteUrl(url)
    && normalizePostWriteUrl(url) === normalizePostWriteUrl(targetUrl);
}

function activePostWritePage(context, fallbackPage, targetUrl = "") {
  const pages = context.pages().filter((item) => !item.isClosed());
  return pages.find((item) => targetUrl && matchesTargetPostWriteUrl(item.url(), targetUrl))
    || pages.find((item) => looksLikePostWriteUrl(item.url()))
    || activePage(context, fallbackPage);
}

async function hasExistingDraftContent(page, titleLocator = null) {
  const titleText = titleLocator
    ? await titleLocator.evaluate((node) => String(node.value || node.innerText || node.textContent || "").trim()).catch(() => "")
    : "";
  if (titleText.length >= 2) return true;
  const roots = [page, ...page.frames()];
  for (const root of roots) {
    const found = await root.evaluate(() => {
      const textSelectors = [
        ".se-module-text",
        ".se-section-text [contenteditable='true']",
        ".se-component-content",
        "[contenteditable='true']"
      ];
      const text = textSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .map((node) => String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ");
      const imageCount = document.querySelectorAll(".se-module-image img, img[src*='blogfiles'], img").length;
      return text.length >= 30 || imageCount > 0;
    }).catch(() => false);
    if (found) return true;
  }
  return false;
}

async function waitForPostWriteTitle(page, selectors, options, postWriteUrl, log, timeout = 5 * 60 * 1000) {
  let deadline = Date.now() + timeout;
  let editorLogged = false;
  let securityLogged = false;
  let wrongUrlCount = 0;

  while (Date.now() < deadline) {
    const url = page.url();
    const bodyText = await readBodyText(page);
    const loginState = await detectLoginState(page, selectors);

    if (loginState.state === "security_check") {
      if (!securityLogged) {
        log("글쓰기 진입 중 네이버 보안 확인이 표시되었습니다. 직접 완료하면 자동으로 이어갑니다.", "warn");
        securityLogged = true;
      }
      await completeLoginIfNeeded(page, selectors, options, log);
      await gotoResilient(page, postWriteUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      deadline = Date.now() + timeout;
      continue;
    }

    if (loginState.state === "login_required") {
      await completeLoginIfNeeded(page, selectors, options, log);
      await gotoResilient(page, postWriteUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      deadline = Date.now() + timeout;
      continue;
    }

    if (!matchesTargetPostWriteUrl(url, postWriteUrl)) {
      wrongUrlCount += 1;
      if (!editorLogged || wrongUrlCount % 5 === 0) {
        log(`블로그 글쓰기 URL 재접근 중입니다. 현재 URL: ${url} / 목표 URL: ${postWriteUrl}`, "warn");
        editorLogged = true;
      }
      if (wrongUrlCount >= 20) {
        throw new Error(`블로그 글쓰기 URL을 열지 못했습니다. 현재 URL: ${url} / 목표 URL: ${postWriteUrl}. 계정관리의 Blog ID가 실제 블로그 주소와 맞는지 확인하세요.`);
      }
      if (false && (!editorLogged || wrongUrlCount % 5 === 0)) {
        log(`블로그 글쓰기 URL이 아닌 화면입니다. 글쓰기 URL 재진입을 기다립니다: ${url}`, "warn");
        editorLogged = true;
      }
      await gotoResilient(page, postWriteUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1000);
      continue;
    }
    wrongUrlCount = 0;

    const draftDialogHandled = options.resumeDraftAfterSessionRecovery === true
      ? await resumeExistingDraftDialog(page, log)
      : await dismissExistingDraftDialog(page, log);
    if (draftDialogHandled) {
      deadline = Date.now() + timeout;
      continue;
    }

    if (await hasVisibleEditorPopup(page)) {
      const popupGuidance = options.resumeDraftAfterSessionRecovery === true
        ? "기존 작성글 안내 팝업이 남아 있습니다. 작성 내용을 보존하려면 브라우저에서 이어서 작성 또는 불러오기를 선택하세요."
        : "기존 작성글 안내 팝업이 남아 있어 편집기 입력을 대기합니다. 취소를 누르면 자동으로 이어갑니다.";
      log(popupGuidance, "warn");
      await sleep(1000);
      continue;
    }

    let locator = await findVisibleLocator(page, titleSelectors(selectors), 1200).catch(() => null);
    if (!locator) {
      locator = await findFallbackTitleLocator(page).catch(() => null);
    }
    if (locator) {
      log("블로그 글쓰기 편집기를 확인했습니다.");
      return locator;
    }

    const editorSurface = await findVisibleLocator(page, editorReadySelectors(), 800).catch(() => null);
    if (editorSurface && !editorLogged) {
      log("블로그 글쓰기 편집기 표면은 보이지만 제목 입력 영역을 찾는 중입니다.", "warn");
      editorLogged = true;
    }

    if (!editorLogged) {
      log("블로그 글쓰기 편집기 로딩을 기다리는 중입니다.");
      editorLogged = true;
    }
    await sleep(1000);
  }

  await saveEditorDiagnostics(page, options, log);
  throw new Error("블로그 글쓰기 편집기를 제한 시간 안에 찾지 못했습니다. Naver Editor DOM notes 확인이 필요합니다.");
}

async function restorePostWriteAfterSessionRecovery(page, selectors, options, log, stage) {
  if (options.restorePostWriteAfterRecovery === false || !options.postWriteUrl) {
    return { hasDraft: true, navigated: false };
  }

  const startFresh = options.startFreshAfterRecovery === true;
  log(startFresh
    ? `${stage} 중 재로그인이 완료되었습니다. 같은 창에서 새 글쓰기 화면을 복구합니다.`
    : `${stage} 중 보안 확인이 완료되었습니다. 같은 창에서 작성 중이던 글을 복구합니다.`);
  let navigated = false;
  if (!matchesTargetPostWriteUrl(page.url(), options.postWriteUrl)) {
    await gotoResilient(page, options.postWriteUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    navigated = true;
  }
  const titleLocator = await waitForPostWriteTitle(
    page,
    selectors,
    {
      ...options,
      failOnLoginRequired: false,
      resumeDraftAfterSessionRecovery: !startFresh
    },
    options.postWriteUrl,
    log,
    options.editorCheckTimeout || 5 * 60 * 1000
  );
  const hasDraft = await hasExistingDraftContent(page, titleLocator);
  if (hasDraft && !startFresh) {
    log("작성 중이던 제목/본문 또는 이미지를 확인했습니다. 중단된 단계부터 계속합니다.");
  } else if (hasDraft) {
    log("새 글쓰기 화면에 기존 내용이 남아 있어 작성 단계를 다시 시작합니다.", "warn");
  } else {
    log("작성 중이던 내용이 편집기에 남아 있지 않습니다. 같은 창에서 저장된 생성 결과를 처음부터 다시 입력합니다.", "warn");
  }
  return { hasDraft, titleLocator, navigated };
}

async function collectImageComponentLocators(page) {
  const selector = ".se-component.se-image[data-compid]";
  const components = [];
  for (const root of [page, ...page.frames()]) {
    const locator = root.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      components.push(locator.nth(index));
    }
  }
  return components;
}

async function collectImageComponentIds(page) {
  const components = await collectImageComponentLocators(page);
  const ids = new Set();
  for (const component of components) {
    const id = String(await component.getAttribute("data-compid").catch(() => "") || "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

async function waitForNewImageComponent(page, previousIds, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const components = await collectImageComponentLocators(page);
    const seen = new Set();
    for (const component of components) {
      const id = String(await component.getAttribute("data-compid").catch(() => "") || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (previousIds.has(id)) continue;
      const image = component.locator(".se-module-image img.se-image-resource, .se-module-image img").first();
      const ready = await image.evaluate((element) => {
        const src = String(element.currentSrc || element.getAttribute("src") || "").trim();
        const width = Number(element.naturalWidth || element.getAttribute("width") || 0);
        return Boolean(src) && width >= 80;
      }).catch(() => false);
      if (ready) {
        return component;
      }
    }
    await sleep(300);
  }
  return null;
}

async function insertImageByButton(page, selector, filePath) {
  const previousImageComponentIds = await collectImageComponentIds(page);
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10000 });
  const button = await findVisibleLocator(page, selector, 20000);
  await safeClickLocator(page, button);
  const chooser = await chooserPromise;
  await chooser.setFiles(filePath);
  const imageComponent = await waitForNewImageComponent(page, previousImageComponentIds);
  await sleep(600);
  return imageComponent;
}

async function isAiMarkToggleSelected(locator) {
  return locator.evaluate((element) => {
    const className = String(element.className || "");
    const parentClassName = String(element.closest?.(".se-set-ai-mark-button")?.className || "");
    return className.includes("se-is-selected")
      || parentClassName.includes("se-is-selected")
      || element.getAttribute("aria-pressed") === "true"
      || element.getAttribute("aria-checked") === "true";
  }).catch(() => false);
}

async function waitForAiMarkToggleSelected(locator, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isAiMarkToggleSelected(locator)) return true;
    await sleep(120);
  }
  return false;
}

async function clickAiMarkToggle(page, locator, log, label) {
  await safeClickLocator(page, locator, log, label).catch(async () => {
    const box = await locator.boundingBox().catch(() => null);
    if (!box) throw new Error(`${label} 위치를 계산할 수 없습니다.`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(250);
  });
}

async function restoreEditorFocusAfterAiMark(page, imageLocator, toggleLocator) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await toggleLocator.evaluate((element) => {
      const active = element.ownerDocument?.activeElement;
      const wrapper = element.closest?.(".se-set-ai-mark-button");
      if (active === element || wrapper?.contains(active)) {
        active?.blur?.();
      }
      element.blur?.();
    }).catch(() => {});

    const box = await imageLocator.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(180);
    const toggleFocused = await toggleLocator.evaluate((element) => {
      const active = element.ownerDocument?.activeElement;
      const wrapper = element.closest?.(".se-set-ai-mark-button");
      return active === element || Boolean(wrapper?.contains(active));
    }).catch(() => true);
    if (!toggleFocused && await isAiMarkToggleSelected(toggleLocator)) {
      return true;
    }
  }
  return false;
}

async function ensureAiMarkForImageComponent(page, imageComponent, log, label = "이미지") {
  try {
    if (!imageComponent) {
      log(`${label}의 새 이미지 컴포넌트를 식별하지 못해 AI 활용 설정을 건너뜁니다.`, "warn");
      return false;
    }

    const componentId = String(await imageComponent.getAttribute("data-compid").catch(() => "") || "").trim();
    const imageLocator = imageComponent.locator(
      ".se-module-image img.se-image-resource, .se-module-image img"
    ).first();
    await imageComponent.scrollIntoViewIfNeeded().catch(() => {});
    await imageLocator.hover({ timeout: 2000 }).catch(() => {});
    await sleep(350);

    const aiMarkButton = imageComponent.locator(".se-set-ai-mark-button-toggle").first();
    const toggleVisible = await aiMarkButton.waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!toggleVisible) {
      log(`${label}(${componentId || "unknown"}) 내부에서 AI 활용 설정 토글을 찾지 못했습니다.`, "warn");
      return false;
    }

    if (await isAiMarkToggleSelected(aiMarkButton)) {
      if (await restoreEditorFocusAfterAiMark(page, imageLocator, aiMarkButton)) {
        log(`${label} AI 활용 설정이 이미 켜져 있습니다. (${componentId || "unknown"})`);
        return true;
      }
      log(`${label} AI 활용 설정은 켜졌지만 토글 포커스를 해제하지 못했습니다.`, "warn");
      return false;
    }

    await clickAiMarkToggle(page, aiMarkButton, log, `${label} AI 활용 설정`);
    if (await waitForAiMarkToggleSelected(aiMarkButton)) {
      if (await restoreEditorFocusAfterAiMark(page, imageLocator, aiMarkButton)) {
        log(`${label} AI 활용 설정을 켰습니다. (${componentId || "unknown"})`);
        return true;
      }
      log(`${label} AI 활용 설정은 켜졌지만 토글 포커스를 해제하지 못했습니다.`, "warn");
      return false;
    }

    await clickAiMarkToggle(page, aiMarkButton, log, `${label} AI 활용 설정 재시도`);
    if (await waitForAiMarkToggleSelected(aiMarkButton)) {
      if (await restoreEditorFocusAfterAiMark(page, imageLocator, aiMarkButton)) {
        log(`${label} AI 활용 설정을 켰습니다. (${componentId || "unknown"})`);
        return true;
      }
      log(`${label} AI 활용 설정은 켜졌지만 토글 포커스를 해제하지 못했습니다.`, "warn");
      return false;
    }

    log(`${label} AI 활용 설정 토글을 찾았지만 켜진 상태를 확인하지 못했습니다.`, "warn");
  } catch (error) {
    log(`${label} AI 활용 설정 확인을 건너뜁니다: ${error.message.split("\n")[0]}`, "warn");
  }
  return false;
}

async function clickOptionalEditorButton(page, selector, label, log, timeout = 4000) {
  if (!selector) return false;
  const button = await findVisibleLocator(page, selector, timeout).catch(() => null);
  if (!button) {
    log(`${label} 버튼을 찾지 못해 일반 문단으로 진행합니다.`, "warn");
    return false;
  }
  await safeClickLocator(page, button, log, label);
  return true;
}

async function chooseQuoteStyle(page, styleLabel, log) {
  const label = String(styleLabel || "").trim();
  if (!label) return false;
  const selected = await clickVisibleText(page, label, 1800);
  if (!selected) {
    log(`인용구 스타일 '${label}'을 찾지 못해 기본 인용구 스타일로 진행합니다.`, "warn");
  }
  return selected;
}

async function clickLocatorRightEdge(page, locator, log, label) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    throw new Error(`${label} 위치를 계산할 수 없습니다.`);
  }
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 6 }).catch(() => {});
  await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
  await sleep(300);
}

async function openQuoteDropdown(page, selectors, styleLabel, log) {
  const selectVisibleQuoteOption = async () => {
    const optionSelector = quoteStyleOptionSelector(styleLabel);
    if (!optionSelector) return false;
    const option = await findVisibleLocator(page, optionSelector, 1200).catch(() => null);
    if (!option) return false;
    await safeClickLocator(page, option, log, `인용구 ${styleLabel} 옵션`);
    return true;
  };

  if (await selectVisibleQuoteOption()) {
    return styleLabel;
  }

  const quoteButtons = await collectVisibleLocators(page, selectors.quoteButton);
  const allButtons = await collectVisibleLocators(page, "button, [role='button']");
  const candidates = [];

  for (const quoteButton of quoteButtons) {
    const quoteBox = await quoteButton.boundingBox().catch(() => null);
    if (!quoteBox || quoteBox.width < 16 || quoteBox.height < 16) continue;

    for (const button of allButtons) {
      if (button === quoteButton) continue;
      const box = await button.boundingBox().catch(() => null);
      if (!box || box.width < 8 || box.height < 8 || box.width > 44) continue;
      const yOverlap = Math.max(0, Math.min(quoteBox.y + quoteBox.height, box.y + box.height) - Math.max(quoteBox.y, box.y));
      const nearRight = box.x >= quoteBox.x + quoteBox.width - 2 && box.x <= quoteBox.x + quoteBox.width + 56;
      if (nearRight && yOverlap >= Math.min(quoteBox.height, box.height) * 0.45) {
        candidates.push({ button, box, score: box.x - quoteBox.x });
      }
    }

    candidates.push({
      point: {
        x: quoteBox.x + quoteBox.width + 10,
        y: quoteBox.y + quoteBox.height / 2
      },
      box: quoteBox,
      score: 999
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  for (const candidate of candidates) {
    if (candidate.button) {
      await safeClickLocator(page, candidate.button, log, "인용구 화살표");
    } else {
      await page.mouse.move(candidate.point.x, candidate.point.y, { steps: 6 }).catch(() => {});
      await page.mouse.click(candidate.point.x, candidate.point.y);
      await sleep(300);
    }
    if (await selectVisibleQuoteOption()) {
      return styleLabel;
    }
    if (await clickVisibleMenuText(page, styleLabel, 800)) {
      return styleLabel;
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(150);
  }

  return "";
}

function quoteStyleOptionSelector(styleLabel) {
  const normalized = String(styleLabel || "").trim();
  if (normalized === "따옴표") {
    return [
      "button[data-name='quotation'][data-value='default']",
      ".se-toolbar-option-insert-quotation-default-button"
    ].join(", ");
  }
  if (normalized === "버티컬 라인") {
    return [
      "button[data-name='quotation'][data-value='quotation_line']",
      ".se-toolbar-option-insert-quotation-quotation_line-button"
    ].join(", ");
  }
  return "";
}

async function openQuoteStyleBlock(page, selectors, styleLabel, log) {
  const openedStyle = await openQuoteDropdown(page, selectors, styleLabel, log);
  if (openedStyle === styleLabel) {
    return true;
  }

  log(`인용구 화살표 메뉴에서 '${styleLabel}'을 선택하지 못했습니다.`, "warn");
  return false;
}

async function prepareBodyAfterTitleImage(page, selectors, log) {
  const editor = await findLowerVisibleLocator(page, bodyEditorSelectors(selectors), 30000);
  await safeClickLocator(page, editor, log, "본문 입력 영역");
  await page.keyboard.press("End").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  log("대표 이미지 아래 본문 입력 위치를 확보했습니다.");
}

function bodyEditorSelectors(selectors) {
  return [
    selectors.bodyEditor,
    ".se-section-text .se-module-text",
    ".se-module-text p",
    ".se-module-text",
    ".se-section-text [contenteditable='true']",
    "div[contenteditable='true']",
    "[contenteditable='true']"
  ].filter(Boolean);
}

function normalBodyEditorSelectors(selectors) {
  return [
    ".se-component:not(.se-component-quotation) .se-section-text .se-module-text p",
    ".se-component:not(.se-component-quotation) .se-section-text .se-module-text",
    ".se-section-text:not(.se-section-quotation) .se-module-text p",
    ".se-section-text:not(.se-section-quotation) .se-module-text",
    ".se-section-text:not(.se-section-quotation) [contenteditable='true']",
    selectors.bodyEditor,
    ".se-module-text p",
    ".se-module-text",
    "div[contenteditable='true']",
    "[contenteditable='true']"
  ].filter(Boolean);
}

async function isNormalBodyTextLocator(locator) {
  return locator.evaluate((node) => {
    const blockedAncestor = node.closest([
      ".se-component-quotation",
      ".se-section-quotation",
      "[class*='quotation']",
      "[class*='quote']",
      "[class*='source']",
      "[class*='caption']",
      "[class*='toolbar']",
      "[class*='popup']",
      "[class*='title']"
    ].join(", "));
    if (blockedAncestor) return false;

    const metaText = [
      node.className,
      node.getAttribute("class"),
      node.getAttribute("placeholder"),
      node.getAttribute("aria-label")
    ].join(" ").toLowerCase();
    const visibleText = String(node.textContent || "");

    return !/(quotation|quote|source|caption|toolbar|popup|title)/i.test(metaText)
      && !/(\ucd9c\ucc98|\uc81c\ubaa9)/.test(visibleText);
  });
}

async function clickBelowQuoteBlock(page) {
  const quoteSelectors = [
    ".se-component:has(.se-module-quotation)",
    ".se-component:has([class*='quotation'])",
    ".se-component:has([class*='quote'])",
    ".se-section-quotation",
    ".se-quotation-container",
    ".se-module-quotation",
    ".se-component-quotation",
    ".se-module-quote",
    ".se-quote"
  ];
  const quotes = await collectVisibleLocators(page, quoteSelectors);
  let lowest = null;
  for (const item of quotes) {
    const box = await item.boundingBox().catch(() => null);
    if (!box || box.width < 180 || box.height < 24) continue;
    const isEditorQuote = await item.evaluate((node) => {
      const blocked = node.closest([
        "[class*='toolbar']",
        "[class*='popup']",
        "[class*='menu']",
        "[role='menu']",
        "button"
      ].join(", "));
      if (blocked) return false;
      const metaText = [
        node.className,
        node.getAttribute("class"),
        node.getAttribute("data-name"),
        node.getAttribute("data-value")
      ].join(" ").toLowerCase();
      return /(quotation|quote)/i.test(metaText);
    }).catch(() => false);
    if (!isEditorQuote) continue;
    if (!lowest || box.y + box.height > lowest.box.y + lowest.box.height) {
      lowest = { item, box };
    }
  }
  if (!lowest) return false;

  const x = lowest.box.x + lowest.box.width / 2;
  const y = lowest.box.y + lowest.box.height + 10;
  await page.mouse.move(x, y, { steps: 8 }).catch(() => {});
  await page.mouse.click(x, y);
  await sleep(300);
  return true;
}

async function exitQuoteBlock(page, selectors, log, options = {}) {
  const quiet = options.quiet === true;
  const quietLog = quiet ? () => {} : log;
  await page.keyboard.press("End").catch(() => {});
  const clickedBelowQuote = await clickBelowQuoteBlock(page);
  if (!clickedBelowQuote) {
    await page.keyboard.press("ArrowDown").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
  }

  const editor = clickedBelowQuote
    ? null
    : await findLowerVisibleLocator(page, bodyEditorSelectors(selectors), 5000).catch(() => null);
  if (editor) {
    await safeClickLocator(page, editor, quietLog, "본문 입력 영역");
    await page.keyboard.press("End").catch(() => {});
  }
  if (!quiet) {
    log("인용구 블록을 종료하고 일반 문단 입력 위치로 이동했습니다.");
  }
}

async function focusBodyParagraph(page, selectors, log, label = "본문 문단 입력 위치") {
  await page.keyboard.press("Escape").catch(() => {});
  let editor = await findLowerVisibleLocator(
    page,
    normalBodyEditorSelectors(selectors),
    5000,
    isNormalBodyTextLocator
  ).catch(() => null);
  if (!editor) {
    await clickBelowQuoteBlock(page).catch(() => false);
    editor = await findLowerVisibleLocator(
      page,
      normalBodyEditorSelectors(selectors),
      5000,
      isNormalBodyTextLocator
    ).catch(() => null);
  }
  if (editor) {
    await safeClickLocator(page, editor, log, label);
    await page.keyboard.press("End").catch(() => {});
    return editor;
  }
  log(`${label}를 찾지 못했습니다. 현재 커서 위치에 입력합니다.`, "warn");
  return null;
}

async function insertQuoteBlock(page, selectors, text, styleLabel, label, log, options = {}) {
  const quiet = options.quiet === true;
  const quietLog = quiet ? () => {} : log;
  const enabled = await openQuoteStyleBlock(page, selectors, styleLabel, quietLog);
  if (!enabled) {
    if (!quiet) {
      log(`${label}에 필요한 '${styleLabel}' 스타일을 선택하지 못해 일반 문단으로 입력합니다.`, "warn");
    }
    await page.keyboard.press("Escape").catch(() => {});
    await focusBodyParagraph(page, selectors, quietLog, `${label} fallback 입력 위치`);
    await page.keyboard.type(String(text || ""), { delay: 42 });
    await page.keyboard.press("Enter").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    return true;
  }

  await page.keyboard.type(String(text || ""), { delay: 42 });
  await exitQuoteBlock(page, selectors, log, { quiet });
  if (!quiet) {
    log(`${label} 입력 완료`);
  }
  return true;
}

async function insertSectionHeadingBlock(page, selectors, text, log) {
  return insertQuoteBlock(page, selectors, text, "버티컬 라인", "소제목 버티컬 라인", log, { quiet: true });
}

async function insertTitleQuoteAtTop(page, selectors, title, titleLocator, log) {
  const titleBox = await titleLocator.boundingBox().catch(() => null);
  const bodyTop = await findTopBodyLocator(page, bodyEditorSelectors(selectors), titleBox, 30000);
  await safeClickLocator(page, bodyTop, log, "본문 최상단 입력 영역");
  await insertQuoteBlock(page, selectors, title, "따옴표", "최상단 제목 인용구", log);
}

function stripDuplicateTitleLine(article, title) {
  const lines = String(article || "").split(/\r?\n/);
  const normalizedTitle = String(title || "").trim();
  while (lines.length && !lines[0].trim()) lines.shift();
  if (normalizedTitle && lines[0] && lines[0].trim() === normalizedTitle) {
    lines.shift();
  }
  return lines.join("\n").trim();
}

function splitArticleBlocks(article) {
  const rawBlocks = String(article || "")
    .split(/(\[IMAGE INSERT - \d+\])/g)
    .filter((block) => block && block.trim());
  const blocks = [];
  const sectionPattern = /^\[(?:SECTION|SUBTITLE)\s*-\s*(.+?)\]?$/i;

  for (const rawBlock of rawBlocks) {
    const marker = rawBlock.match(/\[IMAGE INSERT - (\d+)\]/);
    if (marker) {
      blocks.push({ type: "image", sequence: Number(marker[1]) });
      continue;
    }

    const paragraphs = rawBlock
      .split(/\n{2,}|\r?\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    for (const paragraph of paragraphs) {
      const section = paragraph.match(sectionPattern);
      if (section) {
        blocks.push({ type: "section", text: section[1].trim() });
        continue;
      }

      blocks.push({ type: "paragraph", text: paragraph });
    }
  }

  return blocks;
}

async function insertArticleWithImages(page, selectors, article, bodyImages, options, log) {
  const blocks = splitArticleBlocks(article);
  const bodyTypingLog = () => {};
  log("본문 글쓰기 시작");
  await assertNaverSessionActive(page, selectors, log, "본문 입력 시작", options.sessionRecoveryOptions);
  const editor = await findLowerVisibleLocator(page, bodyEditorSelectors(selectors), 30000);
  await safeClickLocator(page, editor, log, "본문 입력 영역");
  await page.keyboard.press("End").catch(() => {});

  for (const block of blocks) {
    await assertNaverSessionActive(page, selectors, log, "본문 입력", options.sessionRecoveryOptions);
    if (block.type === "paragraph") {
      await typeBodyParagraph(page, block.text, options, bodyTypingLog);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      continue;
    }

    if (block.type === "section") {
      await insertSectionHeadingBlock(page, selectors, block.text, log);
      continue;
    }

    const image = bodyImages.find((item) => Number(item.sequence) === block.sequence);
    if (!image) {
      log(`본문 이미지 ${block.sequence} 파일이 없어 건너뜁니다.`, "warn");
      continue;
    }
    if (!selectors.imageButton) {
      throw new Error("본문 이미지 삽입용 imageButton selector가 필요합니다. Naver Editor DOM notes에 imageButton을 입력해 주세요.");
    }

    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    const imageComponent = await insertImageByButton(page, selectors.imageButton, image.path);
    await ensureAiMarkForImageComponent(page, imageComponent, log, `본문 이미지 ${block.sequence}`);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    log(`본문 이미지 ${block.sequence} 삽입 완료`);
  }
  log("본문 글쓰기 완료");
}

async function inputTags(page, selector, tags, log) {
  const sanitizeNaverTag = (value) => String(value || "")
    .replace(/^#+/, "")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
  const cleanTags = (Array.isArray(tags) ? tags : [])
    .map(sanitizeNaverTag)
    .filter(Boolean)
    .slice(0, 29);
  if (!cleanTags.length) return;

  const input = await findVisibleLocator(page, selector, 12000);
  await safeClickLocator(page, input, log, "태그 입력칸");
  for (const tag of cleanTags) {
    await page.keyboard.type(tag, { delay: 50 });
    await page.keyboard.press("Space");
    await sleep(160);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(400);
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
  await page.keyboard.press("Tab").catch(() => {});
  await sleep(400);
  const layer = await findVisibleLocator(page, "[class*='layer_popup'], div[role='dialog'], [class*='publish']", 1500).catch(() => null);
  if (layer) {
    const box = await layer.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + Math.min(box.width - 20, 40), box.y + Math.min(box.height - 20, 40));
      await sleep(350);
    }
  }
  log(`태그 ${cleanTags.length}개 입력 완료`);
}

function looksLikePublishComplete(url, bodyText) {
  const text = String(bodyText || "");
  if (/발행되었습니다|게시되었습니다|등록되었습니다|저장되었습니다|완료되었습니다|발행\s*완료|게시\s*완료/i.test(text)) {
    return true;
  }
  return /blog\.naver\.com/i.test(url) && !/postwrite/i.test(url) && /PostView|Redirect|postView/i.test(url);
}

async function waitForPublishCompletion(page, selectors, log, timeout = 60000, sessionRecoveryOptions = {}) {
  const deadline = Date.now() + timeout;
  let confirmClicks = 0;

  while (Date.now() < deadline) {
    const url = page.url();
    const bodyText = await readBodyText(page);
    await assertNaverSessionActive(page, selectors, log, "발행 완료 확인", sessionRecoveryOptions);
    if (looksLikePublishComplete(url, bodyText)) {
      log("Naver 발행 완료를 확인했습니다.");
      return;
    }

    if (confirmClicks < 2 && /발행|게시|등록|완료|확인/i.test(bodyText)) {
      const clickedConfirm = await clickExactPopupButton(page, "확인");
      if (clickedConfirm) {
        confirmClicks += 1;
        log("발행 확인 팝업의 확인 버튼을 클릭했습니다.");
        await sleep(1800);
        continue;
      }
    }

    const finalButtons = await collectVisibleLocators(page, selectors.finalPublishButton);
    if (!finalButtons.length && /postwrite/i.test(url)) {
      await sleep(1000);
      continue;
    }

    await sleep(1000);
  }

  throw new Error("최종 발행 완료 상태를 확인하지 못했습니다. 화면의 알림 또는 발행 버튼 상태 확인이 필요합니다.");
}

function publishVisibilityFromOptions(options = {}) {
  return String(options.publishVisibility || (options.publishPrivate ? "private" : "public")).toLowerCase();
}

function shouldUseReservedPublishSchedule(options = {}) {
  return publishVisibilityFromOptions(options) === "public"
    && options.publishPrivate !== true
    && String(options.publishScheduleMode || "now") === "reserve";
}

function isPublishSettingsButtonMeta(meta = {}) {
  return String(meta.dataClickArea || "") === "tpb.publish"
    || /(?:^|\s)publish_btn__/.test(String(meta.className || ""));
}

function isReservedPostListButtonText(text) {
  return /\uC608\uC57D\s*\uBC1C\uD589\s*\d+\s*\uAC74/i.test(String(text || "").replace(/\s+/g, " ").trim());
}

async function readControlMeta(locator) {
  return locator.evaluate((element) => {
    const control = element.closest([
      "button",
      "a",
      "label",
      "[role='button']",
      "[role='menuitem']",
      "[role='option']"
    ].join(",")) || element;
    return {
      dataClickArea: control.getAttribute("data-click-area") || "",
      dataTestId: control.getAttribute("data-testid") || "",
      className: String(control.className || ""),
      text: String(control.innerText || control.textContent || "").replace(/\s+/g, " ").trim()
    };
  }).catch(() => ({}));
}

function isReservedPostListButtonMeta(meta = {}) {
  return String(meta.dataClickArea || "") === "tpb*t.schedule"
    || /(?:^|\s)reserve_btn__/.test(String(meta.className || ""))
    || isReservedPostListButtonText(meta.text);
}

async function clickPublishSettingsButton(page, selectors, log) {
  const preferredSelectors = [
    "button[data-click-area='tpb.publish']",
    "[data-click-area='tpb.publish']",
    "button[class*='publish_btn__']",
    selectors.publishButton
  ].filter(Boolean);

  for (const selector of preferredSelectors) {
    const candidates = await collectVisibleLocators(page, selector);
    const ranked = [];
    for (const item of candidates) {
      const box = await item.boundingBox().catch(() => null);
      const buttonText = await item.innerText({ timeout: 500 }).catch(() => "");
      const meta = await readControlMeta(item);
      if (!isPublishSettingsButtonMeta(meta)) continue;
      if (isReservedPostListButtonMeta(meta)) continue;
      if (String(meta.dataTestId || "") === "seOnePublishBtn") continue;
      if (String(meta.dataClickArea || "") === "tpb*i.publish") continue;
      if (isReservedPostListButtonText(buttonText)) continue;
      const disabled = await item.evaluate((element) => Boolean(
        element.disabled
        || element.getAttribute("aria-disabled") === "true"
        || element.className && String(element.className).includes("disabled")
      )).catch(() => false);
      if (!box || disabled || box.width < 20 || box.height < 15) continue;
      ranked.push({ item, box });
    }
    ranked.sort((a, b) => (b.box.x - a.box.x) || (a.box.y - b.box.y));
    if (ranked[0]) {
      await clickLocatorResilient(page, ranked[0].item, log, "발행 설정 버튼");
      return true;
    }
  }

  log("발행 설정 버튼을 찾지 못했습니다.", "warn");
  return false;
}

async function waitForPublishSettingsLayer(page, selectors, log, timeout = 7000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const items = await collectVisibleLocators(page, selectors.finalPublishButton).catch(() => []);
    for (const item of items) {
      const meta = await readControlMeta(item);
      if (isPublishSettingsButtonMeta(meta)) continue;
      if (isReservedPostListButtonMeta(meta)) continue;
      return true;
    }
    await sleep(300);
  }

  log("발행 설정 레이어가 열리지 않았습니다. 첫 번째 발행 버튼 선택자를 확인해야 합니다.", "warn");
  return false;
}

async function clickFinalPublishButton(page, selectors, log, options = {}) {
  void options;
  const preferredSelectors = [
    "button[data-testid='seOnePublishBtn']",
    "[data-testid='seOnePublishBtn']",
    "button[data-click-area='tpb*i.publish']",
    "[data-click-area='tpb*i.publish']",
    selectors.finalPublishButton
  ].filter(Boolean);

  for (const selector of preferredSelectors) {
    const candidates = await collectVisibleLocators(page, selector);
    const ranked = [];
    for (const item of candidates) {
      const box = await item.boundingBox().catch(() => null);
      const buttonText = await item.innerText({ timeout: 500 }).catch(() => "");
      const meta = await readControlMeta(item);
      if (isPublishSettingsButtonMeta(meta)) continue;
      if (isReservedPostListButtonMeta(meta)) continue;
      if (isReservedPostListButtonText(buttonText)) continue;
      const disabled = await item.evaluate((element) => Boolean(
        element.disabled
        || element.getAttribute("aria-disabled") === "true"
        || element.className && String(element.className).includes("disabled")
      )).catch(() => false);
      if (!box || disabled || box.width < 20 || box.height < 15) continue;
      ranked.push({ item, box });
    }
    ranked.sort((a, b) => (b.box.y - a.box.y) || (b.box.x - a.box.x));
    if (ranked[0]) {
      await clickLocatorResilient(page, ranked[0].item, log, "최종 발행 버튼");
      log("최종 발행 버튼 클릭 완료, 완료 상태를 확인합니다.");
      return true;
    }
  }

  log("최종 발행 버튼을 찾지 못했습니다.", "warn");
  return false;
}

async function applyPublishVisibility(page, selectors, options, log) {
  const visibility = String(options.publishVisibility || (options.publishPrivate ? "private" : "public"));
  const targetLabel = visibility === "public" ? "전체공개" : "비공개";
  const selector = visibility === "public" ? selectors.publicOption : selectors.privateOption;
  const option = await findVisibleLocator(page, selector, 5000).catch(() => null);
  if (option) {
    await safeClickLocator(page, option, log, `${targetLabel} 옵션`);
    log(`공개설정을 ${targetLabel}로 선택했습니다.`);
    return true;
  }
  if (await clickVisibleMenuText(page, targetLabel, 2500)) {
    log(`공개설정을 ${targetLabel}로 선택했습니다.`);
    return true;
  }
  throw new Error(`공개설정 '${targetLabel}' 옵션을 찾을 수 없습니다. Naver Editor DOM notes 확인이 필요합니다.`);
}

function getReservedDateParts(offsetHours, baseDate = new Date()) {
  const scheduledAt = new Date(baseDate.getTime() + Math.max(0, Number(offsetHours || 0)) * 60 * 60 * 1000);
  const roundedMinute = Math.ceil(scheduledAt.getMinutes() / 10) * 10;
  if (roundedMinute >= 60) {
    scheduledAt.setHours(scheduledAt.getHours() + 1, 0, 0, 0);
  } else {
    scheduledAt.setMinutes(roundedMinute, 0, 0);
  }
  return {
    date: `${scheduledAt.getFullYear()}. ${String(scheduledAt.getMonth() + 1).padStart(2, "0")}. ${String(scheduledAt.getDate()).padStart(2, "0")}`,
    hour: String(scheduledAt.getHours()).padStart(2, "0"),
    minute: String(scheduledAt.getMinutes()).padStart(2, "0")
  };
}

async function fillPublishField(page, selectors, value, label, log) {
  const locator = await findVisibleLocator(page, selectors, 4000).catch(() => null);
  if (!locator) return false;
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const filled = await locator.evaluate((node, nextValue) => {
    const setNativeValue = (target, value) => {
      const nodeTag = String(target.tagName || "").toLowerCase();
      const proto = nodeTag === "select"
        ? HTMLSelectElement.prototype
        : nodeTag === "textarea"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor?.set) {
        descriptor.set.call(target, value);
      } else {
        target.value = value;
      }
    };
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "select") {
      const optionValues = Array.from(node.options || []).map((option) => option.value);
      const selectedValue = optionValues.includes(nextValue)
        ? nextValue
        : optionValues.find((item) => Number(item) === Number(nextValue));
      if (!selectedValue) return false;
      setNativeValue(node, selectedValue);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return node.value === selectedValue;
    }
    if (tag === "input" || tag === "textarea") {
      const wasReadOnly = node.readOnly;
      node.readOnly = false;
      setNativeValue(node, nextValue);
      node.setAttribute("value", nextValue);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      node.dispatchEvent(new Event("blur", { bubbles: true }));
      node.readOnly = wasReadOnly;
      return String(node.value || "").trim() === String(nextValue || "").trim();
    }
    return false;
  }, String(value)).catch(() => false);
  if (!filled) {
    await safeClickLocator(page, locator, log, label);
    await page.keyboard.press("Control+A");
    await page.keyboard.type(String(value), { delay: 35 });
  }
  log(`${label} 입력: ${value}`);
  return true;
}

async function findPublishScheduleOption(page, selectors, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const candidates = await collectVisibleLocators(page, selectors).catch(() => []);
    for (const item of candidates) {
      const meta = await readControlMeta(item);
      if (isReservedPostListButtonMeta(meta)) continue;
      return item;
    }
    await sleep(250);
  }
  return null;
}

async function applyPublishSchedule(page, selectors, options, log) {
  if (!shouldUseReservedPublishSchedule(options)) {
    const nowOption = await findPublishScheduleOption(page, selectors.nowOption, 1500);
    if (String(options.publishScheduleMode || "now") === "reserve") {
      log("비공개 발행은 예약 대신 현재 발행으로 전환했습니다.");
    }
    if (nowOption) {
      await safeClickLocator(page, nowOption, log, "현재 발행 옵션");
    }
    return;
  }

  const publishSettingsVisible = await waitForPublishSettingsLayer(page, selectors, log, 2500);
  if (!publishSettingsVisible) {
    throw new Error("Naver publish settings layer did not open. The automation may have reached the reserved-post list layer instead of the publish layer; verify the first publish button selector targets data-click-area='tpb.publish'.");
  }

  const reserveOption = await findPublishScheduleOption(page, selectors.reserveOption, 5000);
  if (reserveOption) {
    await safeClickLocator(page, reserveOption, log, "예약 발행 옵션");
  } else {
    throw new Error("Naver publish settings layer is open, but the reserved publish option was not found.");
  }

  const parts = getReservedDateParts(options.reserveAfterHours);
  const filledDate = await fillPublishField(page, selectors.reserveDateInput, parts.date, "예약 날짜", log);
  const filledHour = await fillPublishField(page, selectors.reserveHourInput, parts.hour, "예약 시간", log);
  const filledMinute = await fillPublishField(page, selectors.reserveMinuteInput, parts.minute, "예약 분", log);
  if (!filledDate || !filledHour || !filledMinute) {
    throw new Error("예약 날짜/시간/분 입력칸을 찾을 수 없습니다. Naver Editor DOM notes에 reserveDateInput, reserveHourInput, reserveMinuteInput을 지정해 주세요.");
  }
}

async function publishToNaver(options) {
  const log = options.log || (() => {});
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    throw new Error("playwright-core가 설치되어 있지 않아 Naver 브라우저 자동화를 실행할 수 없습니다.");
  }

  const selectors = {
    idInput: "#id",
    passwordInput: "#pw",
    titleInput: "textarea[placeholder*='제목'], input[placeholder*='제목'], .se-title-text [contenteditable='true'], .se-title [contenteditable='true'], .se-title-text textarea, .se-title-text input",
    bodyEditor: ".se-section-text .se-module-text, .se-module-text p, .se-module-text, .se-section-text [contenteditable='true'], div[contenteditable='true']",
    imageButton: [
      "button[aria-label*='사진']",
      "button[aria-label*='이미지']",
      "button[title*='사진']",
      "button[title*='이미지']",
      ".se-toolbar-item-image button",
      ".se-image-toolbar-button",
      "button[data-name='image']",
      "button[data-name='photo']",
      "button[class*='image']",
      "button[class*='photo']"
    ].join(", "),
    quoteButton: [
      "button[aria-label*='인용']",
      "button[title*='인용']",
      ".se-toolbar-item-quotation button",
      ".se-toolbar-item-quote button",
      "button[class*='quotation']",
      "button[class*='quote']"
    ].join(", "),
    quoteArrowButton: [
      ".se-toolbar-option-insert-quotation-button",
      ".se-toolbar-option-button[data-name='quotation']",
      "button[data-name='quotation'][data-type='icon-select']",
      ".se-toolbar-item-quotation button",
      ".se-toolbar-item-quote button",
      "[data-name='quotation'] button",
      "[data-name='quote'] button",
      "button[aria-label*='인용']",
      "button[title*='인용']",
      "button[class*='quotation']",
      "button[class*='quote']"
    ].join(", "),
    quoteStyleMenuButton: [
      "button[aria-label*='인용구 스타일']",
      "button[title*='인용구 스타일']",
      "button[aria-label*='인용구 선택']",
      "button[title*='인용구 선택']",
      ".se-toolbar-item-quotation .se-toolbar-option-button",
      ".se-toolbar-item-quote .se-toolbar-option-button",
      "[data-name='quotation'] button[class*='option']",
      "[data-name='quote'] button[class*='option']",
      "button[class*='quotation'][class*='option']",
      "button[class*='quote'][class*='option']",
      "[class*='quotation'] button[aria-haspopup='true']",
      "[class*='quote'] button[aria-haspopup='true']"
    ].join(", "),
    saveButton: "button:has-text('저장')",
    publishButton: [
      "button[data-click-area='tpb.publish']",
      "[data-click-area='tpb.publish']",
      "button[class*='publish_btn__'][data-click-area='tpb.publish']",
      "button[class*='publish_btn__']"
    ],
    finalPublishButton: [
      "button[data-testid='seOnePublishBtn']",
      "[data-testid='seOnePublishBtn']",
      "button[data-click-area='tpb*i.publish']",
      "[data-click-area='tpb*i.publish']"
    ].join(", "),
    privateOption: "text=비공개",
    publicOption: "text=전체공개",
    nowOption: "text=현재",
    reserveOption: "text=예약",
    reserveDateInput: [
      "input[class*='input_date'][readonly][type='text']",
      "input[readonly][type='text'][class*='date']",
      "input[title*='예약 발행 날짜']",
      "input[aria-label*='예약 발행 날짜']",
      "input[readonly][type='text'][value*='.']",
      "input[placeholder*='날짜']",
      "input[aria-label*='날짜']",
      "input[class*='date']",
      "input[name*='date']"
    ].join(", "),
    reserveHourInput: [
      "select[title*='예약 발행 시간']",
      "select[aria-label*='예약 발행 시간']",
      "select:has(option[value='23'])",
      "input[placeholder*='시간']",
      "input[aria-label*='시간']",
      "input[class*='hour']",
      "input[name*='hour']"
    ].join(", "),
    reserveMinuteInput: [
      "select[title*='예약 발행 분']",
      "select[aria-label*='예약 발행 분']",
      "select:has(option[value='50'])",
      "input[placeholder*='분']",
      "input[aria-label*='분']",
      "input[class*='minute']",
      "input[name*='minute']"
    ].join(", "),
    categoryDropdown: [
      "button[aria-haspopup='listbox']",
      "[role='combobox']",
      "[aria-haspopup='listbox']",
      "[class*='dropdown']",
      "[class*='Dropdown']",
      "[class*='select']",
      "[class*='Select']"
    ].join(", "),
    categoryButton: [
      "button:has-text('카테고리')",
      "[class*='category'] button",
      "[data-click-area*='category']",
      "text=카테고리"
    ].join(", "),
    tagInput: "input[placeholder*='태그']",
    ...parseDomNotes(options.domNotes)
  };

  const browserProfileDir = options.browserProfileDir
    || path.join(options.runtimeRoot || process.cwd(), "browser-profile");
  fs.mkdirSync(browserProfileDir, { recursive: true });
  markChromeProfileClean(browserProfileDir);

  const ownsContext = !options.preparedContext;
  const context = options.preparedContext || await chromium.launchPersistentContext(browserProfileDir, chromeLaunchOptions({
    slowMo: 80,
    viewport: { width: 1366, height: 900 }
  }));

  try {
    const postWriteUrl = postWriteUrlFor(options);
    log(`블로그 글쓰기 목표 URL: ${postWriteUrl}`);
    let page = options.preparedPage && !options.preparedPage.isClosed()
      ? options.preparedPage
      : (activePage(context, null) || await context.newPage());
    const resumeExistingDraft = options.resumeExistingDraft === true && options.preparedContext;
    let reuseExistingDraft = resumeExistingDraft;
    const sessionRecoveryOptions = {
      ...options,
      postWriteUrl,
      interactiveLogin: true,
      failOnLoginRequired: false,
      recoverSessionDuringWork: true,
      resumeDraftAfterSessionRecovery: true,
      restartAuthoringWhenDraftMissing: true
    };

    if (resumeExistingDraft) {
      page = activePostWritePage(context, page, postWriteUrl);
      log("열린 Naver 글쓰기 화면의 기존 작성 내용을 우선 재사용합니다.");
      if (!matchesTargetPostWriteUrl(page.url(), postWriteUrl)) {
        page = await gotoResilientInContext(context, page, postWriteUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000
        });
      }
      await completeLoginIfNeeded(page, selectors, sessionRecoveryOptions, log);
    } else if (options.preparedContext) {
      log("이미 열려 있는 글쓰기 브라우저 세션을 사용합니다.");
      page = await gotoResilientInContext(context, page, postWriteUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      log("발행 단계에서 블로그 글쓰기 URL로 다시 접근했습니다.");
      await completeLoginIfNeeded(page, selectors, sessionRecoveryOptions, log);
    } else {
      await gotoResilient(page, "https://naver.com", { waitUntil: "domcontentloaded", timeout: 45000 });
      log("naver.com 접속 완료");

      page = await gotoResilientInContext(context, page, postWriteUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      log("블로그 글쓰기 URL 접근을 시도했습니다.");
      const didLogin = await completeLoginIfNeeded(page, selectors, sessionRecoveryOptions, log);
      if (didLogin) {
        page = await gotoResilientInContext(context, page, postWriteUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000
        });
        log("로그인 후 블로그 글쓰기 URL로 다시 접근했습니다.");
      } else {
        log("기존 브라우저 세션을 사용합니다.");
      }
    }

    for (;;) {
      let finalPublishAttempted = false;
      try {
    const titleLocator = await waitForPostWriteTitle(
      page,
      selectors,
      { ...sessionRecoveryOptions, resumeDraftAfterSessionRecovery: false },
      postWriteUrl,
      log
    );
    const useExistingDraft = reuseExistingDraft && await hasExistingDraftContent(page, titleLocator);
    if (useExistingDraft) {
      log("Naver 글쓰기 화면에 작성된 제목/본문 또는 이미지가 있어 재입력 없이 발행 단계로 이어갑니다.");
    } else {
      if (reuseExistingDraft) {
        log("재사용할 작성 내용이 보이지 않아 저장된 생성 결과로 다시 입력합니다.", "warn");
      }
    await assertNaverSessionActive(page, selectors, log, "제목 입력 전", sessionRecoveryOptions);
    log("블로그 글쓰기 화면 로드를 확인했습니다.");
    await typeIntoLocator(page, titleLocator, options.title);
    await assertNaverSessionActive(page, selectors, log, "제목 입력", sessionRecoveryOptions);
    await insertTitleQuoteAtTop(page, selectors, options.title, titleLocator, log);
    await assertNaverSessionActive(page, selectors, log, "타이틀 인용구 입력", sessionRecoveryOptions);

    if (options.titleImagePath) {
      if (!selectors.imageButton) {
        throw new Error("타이틀 이미지 삽입용 imageButton selector가 필요합니다.");
      }
      await assertNaverSessionActive(page, selectors, log, "타이틀 이미지 삽입 전", sessionRecoveryOptions);
      const titleImageComponent = await insertImageByButton(page, selectors.imageButton, options.titleImagePath);
      await ensureAiMarkForImageComponent(page, titleImageComponent, log, "타이틀 이미지");
      log("타이틀 이미지 삽입 완료");
      await assertNaverSessionActive(page, selectors, log, "타이틀 이미지 삽입", sessionRecoveryOptions);
      await prepareBodyAfterTitleImage(page, selectors, log);
    }

    await assertNaverSessionActive(page, selectors, log, "본문 입력 전", sessionRecoveryOptions);
    await insertArticleWithImages(
      page,
      selectors,
      stripDuplicateTitleLine(options.article, options.title),
      options.bodyImages || [],
      {
        breakSentencesInBody: options.breakSentencesInBody !== false,
        sessionRecoveryOptions
      },
      log
    );
    await assertNaverSessionActive(page, selectors, log, "본문 입력 완료", sessionRecoveryOptions);

    const saveButton = selectors.saveButton
      ? await findVisibleLocator(page, selectors.saveButton, 2500).catch(() => null)
      : null;
    if (saveButton) {
      await assertNaverSessionActive(page, selectors, log, "저장 전", sessionRecoveryOptions);
      await safeClickLocator(page, saveButton, log, "저장 버튼");
      await sleep(1500);
      await assertNaverSessionActive(page, selectors, log, "저장", sessionRecoveryOptions);
    }

    await assertNaverSessionActive(page, selectors, log, "발행 설정 열기 전", sessionRecoveryOptions);
    }
    const publishOpened = await clickPublishSettingsButton(page, selectors, log);
    if (!publishOpened) {
      throw new Error("발행 버튼을 찾을 수 없습니다. Naver Editor DOM notes에 publishButton selector가 필요할 수 있습니다.");
    }
    const publishSettingsVisible = await waitForPublishSettingsLayer(page, selectors, log);
    if (!publishSettingsVisible) {
      throw new Error("발행 설정 레이어가 열리지 않았습니다. 첫 번째 발행 버튼 DOM 확인이 필요합니다.");
    }
    log("발행 설정 화면을 열었습니다.");
    await assertNaverSessionActive(page, selectors, log, "발행 설정", sessionRecoveryOptions);

    await applyPublishVisibility(page, selectors, options, log);
    await assertNaverSessionActive(page, selectors, log, "공개 설정", sessionRecoveryOptions);
    await applyPublishSchedule(page, selectors, options, log);
    await assertNaverSessionActive(page, selectors, log, "발행 시간 설정", sessionRecoveryOptions);

    if (selectors.categoryButton && options.category) {
      await assertNaverSessionActive(page, selectors, log, "카테고리 선택 전", sessionRecoveryOptions);
      await selectCategory(page, selectors, options.category, log);
      await assertNaverSessionActive(page, selectors, log, "카테고리 선택", sessionRecoveryOptions);
    }

    if (!useExistingDraft && selectors.tagInput && Array.isArray(options.tags)) {
      await assertNaverSessionActive(page, selectors, log, "태그 입력 전", sessionRecoveryOptions);
      await inputTags(page, selectors.tagInput, options.tags, log);
      await assertNaverSessionActive(page, selectors, log, "태그 입력", sessionRecoveryOptions);
    }

    await assertNaverSessionActive(page, selectors, log, "최종 발행 전", sessionRecoveryOptions);
    await sleep(1000);
    finalPublishAttempted = true;
    const finalPublished = await clickFinalPublishButton(page, selectors, log, options);
    if (!finalPublished) {
      throw new Error("최종 발행 버튼을 찾을 수 없습니다. 발행 화면 DOM 확인이 필요합니다.");
    }
    const publishCompletionRecoveryOptions = {
      ...sessionRecoveryOptions,
      restorePostWriteAfterRecovery: false,
      restartAuthoringWhenDraftMissing: false
    };
    await assertNaverSessionActive(page, selectors, log, "최종 발행", publishCompletionRecoveryOptions);
    await waitForPublishCompletion(page, selectors, log, 60000, publishCompletionRecoveryOptions);
    break;
      } catch (error) {
        let recoveryError = error;
        if (recoveryError?.code !== "NAVER_AUTHORING_RESTART_REQUIRED") {
          const interruptedState = await detectLoginState(page, selectors).catch(() => ({ state: "available" }));
          if (interruptedState.state !== "security_check" && interruptedState.state !== "login_required") {
            throw recoveryError;
          }
          log("자동 입력 동작 중 네이버 보안 확인 또는 로그인 화면 전환을 감지했습니다. 현재 창에서 복구합니다.", "warn");
          const interruptedRecoveryOptions = finalPublishAttempted
            ? {
                ...sessionRecoveryOptions,
                restorePostWriteAfterRecovery: false,
                restartAuthoringWhenDraftMissing: false
              }
            : sessionRecoveryOptions;
          let recoveredSuccessfully = false;
          try {
            await assertNaverSessionActive(page, selectors, log, "자동 입력 복구", interruptedRecoveryOptions);
            recoveredSuccessfully = true;
          } catch (caughtRecoveryError) {
            recoveryError = caughtRecoveryError;
          }
          if (finalPublishAttempted && recoveredSuccessfully) {
            await waitForPublishCompletion(page, selectors, log, 60000, interruptedRecoveryOptions);
            break;
          }
          if (!recoveredSuccessfully && recoveryError?.code !== "NAVER_AUTHORING_RESTART_REQUIRED") {
            throw recoveryError;
          }
          if (recoveredSuccessfully) {
            recoveryError = authoringRestartRequiredError("자동 입력");
          }
        }
        log(recoveryError.message, "warn");
        reuseExistingDraft = false;
        page = activePostWritePage(context, page, postWriteUrl);
        await gotoResilient(page, "https://naver.com", { waitUntil: "domcontentloaded", timeout: 45000 });
        page = await gotoResilientInContext(context, page, postWriteUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000
        });
        await waitForPostWriteTitle(
          page,
          selectors,
          { ...options, resumeDraftAfterSessionRecovery: false, failOnLoginRequired: false },
          postWriteUrl,
          log
        );
        log("브라우저를 닫지 않고 저장된 제목·본문·이미지로 글 작성을 처음부터 다시 시작합니다.", "warn");
      }
    }
  } finally {
    if (ownsContext) {
      await context.close();
    }
  }
}

async function checkNaverSession(options) {
  const log = options.log || (() => {});
  let shouldCloseContext = true;
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    throw new Error("playwright-core가 설치되어 있지 않아 Naver 세션을 확인할 수 없습니다.");
  }

  const browserProfileDir = options.browserProfileDir
    || path.join(options.runtimeRoot || process.cwd(), "browser-profile");
  fs.mkdirSync(browserProfileDir, { recursive: true });
  markChromeProfileClean(browserProfileDir);

  const context = await chromium.launchPersistentContext(browserProfileDir, chromeLaunchOptions({
    slowMo: 20,
    viewport: { width: 1280, height: 820 }
  }));

  try {
    let page = context.pages()[0] || await context.newPage();
    const selectors = {
      idInput: "#id",
      passwordInput: "#pw",
      titleInput: "textarea[placeholder*='제목'], input[placeholder*='제목'], .se-title-text [contenteditable='true'], .se-title [contenteditable='true'], .se-title-text textarea, .se-title-text input",
      ...parseDomNotes(options.domNotes)
    };
    const targetUrl = postWriteUrlFor(options);
    log(`블로그 글쓰기 목표 URL: ${targetUrl}`);
    await gotoResilient(page, targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    page = activePage(context, page);
    await sleep(1200);
    const keepValidSessionOpen = options.keepOpen === true;
    const withOpenSession = (result) => {
      if (keepValidSessionOpen && result.status === "valid") {
        shouldCloseContext = false;
        return {
          ...result,
          preparedSession: {
            context,
            page,
            browserProfileDir,
            postWriteUrl: targetUrl
          }
        };
      }
      return result;
    };
    const verifyTarget = async () => {
      const result = options.requireEditor === true
        ? await verifyPostWriteEditorSession(context, page, selectors, options, targetUrl, log)
        : await verifyPostWriteSession(context, page, selectors, options, targetUrl, log);
      page = result.page || page;
      return result;
    };

    const loginState = await detectLoginState(page, selectors);
    if (loginState.state === "security_check") {
      log("네이버 보안 확인 완료를 기다립니다. 완료하면 글쓰기 화면을 다시 확인합니다.", "warn");
      const stateAfterSecurityCheck = await waitForSecurityCheckComplete(page, selectors, log, options);
      if (stateAfterSecurityCheck.state === "login_required") {
        if (!options.interactiveLogin) {
          return { status: "expired", reason: "login_required" };
        }
        await completeLoginIfNeeded(page, selectors, options, log);
      }
      const result = await verifyTarget();
      return withOpenSession(result);
    }
    if (loginState.state === "login_required") {
      if (options.interactiveLogin) {
        await completeLoginIfNeeded(page, selectors, options, log);
        const result = await verifyTarget();
        return withOpenSession(result);
      }
      return { status: "expired", reason: "login_required" };
    }
    const result = await verifyTarget();
    return withOpenSession(result);
  } finally {
    if (shouldCloseContext) {
      await context.close();
    }
  }
}

module.exports = {
  publishToNaver,
  checkNaverSession,
  verifyOpenNaverSession,
  _private: {
    getReservedDateParts,
    shouldUseReservedPublishSchedule,
    isPublishSettingsButtonMeta,
    isReservedPostListButtonText,
    clickPublishSettingsButton,
    waitForPublishSettingsLayer,
    sessionExpiredError,
    securityCheckTimeoutError,
    authoringRestartRequiredError,
    looksLikeSecurityCheck,
    detectLoginState,
    waitForSecurityCheckComplete,
    waitForLoginComplete,
    assertNaverSessionActive,
    completeLoginIfNeeded,
    verifyPostWriteSession
  }
};
