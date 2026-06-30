const fs = require("node:fs");
const path = require("node:path");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionExpiredError(message = "Tistory session requires Kakao login.") {
  const error = new Error(message);
  error.code = "TISTORY_SESSION_EXPIRED";
  return error;
}

function tistoryBlogId(options = {}) {
  return String(options.tistoryBlogId || options.blogId || "").trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\.tistory\.com.*$/i, "")
    .replace(/\/.*$/, "");
}

function newPostUrlFor(options = {}) {
  const blogId = tistoryBlogId(options);
  if (!blogId) throw new Error("Tistory blog ID is required.");
  return `https://${encodeURIComponent(blogId)}.tistory.com/manage/newpost`;
}

function postsUrlFor(options = {}) {
  const blogId = tistoryBlogId(options);
  if (!blogId) throw new Error("Tistory blog ID is required.");
  return `https://${encodeURIComponent(blogId)}.tistory.com/manage/posts/`;
}

function markChromeProfileClean(browserProfileDir) {
  if (!browserProfileDir) return;
  for (const fileName of ["Local State", path.join("Default", "Preferences")]) {
    const filePath = path.join(browserProfileDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (data.profile) {
        data.profile.exit_type = "Normal";
        data.profile.exited_cleanly = true;
      }
      if (data.exit_type) data.exit_type = "Normal";
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // Chrome profile metadata is best-effort only.
    }
  }
}

function chromeLaunchOptions({ slowMo = 80, viewport = { width: 1366, height: 900 } } = {}) {
  return {
    channel: "chrome",
    chromiumSandbox: true,
    headless: false,
    slowMo,
    viewport,
    args: [
      "--disable-features=Translate,RendererCodeIntegrity",
      "--disable-session-crashed-bubble",
      "--no-default-browser-check",
      "--no-first-run"
    ]
  };
}

async function gotoResilient(page, url, options = {}) {
  try {
    await page.goto(url, options);
    return page;
  } catch (error) {
    const message = String(error?.message || "");
    if (!/net::ERR_ABORTED|Navigation interrupted|Target closed/i.test(message)) throw error;
    await page.waitForLoadState("domcontentloaded", { timeout: options.timeout || 45000 }).catch(() => {});
    return page;
  }
}

function activePage(context, fallbackPage) {
  const pages = context.pages().filter((item) => !item.isClosed());
  return pages.find((item) => /tistory\.com/i.test(item.url())) || pages[pages.length - 1] || fallbackPage;
}

async function findVisibleLocator(pageOrFrame, selectors, timeout = 20000) {
  const selectorList = Array.isArray(selectors) ? selectors : String(selectors || "").split(/\s*,\s*/);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectorList.filter(Boolean)) {
      const locator = pageOrFrame.locator(selector).first();
      if (await locator.count().catch(() => 0)) {
        const visible = await locator.isVisible({ timeout: 300 }).catch(() => false);
        if (visible) return locator;
      }
    }
    await sleep(250);
  }
  throw new Error(`Visible Tistory element was not found: ${selectorList.join(", ")}`);
}

async function safeClickLocator(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 10000 });
}

async function getEditorFrame(page, timeout = 30000) {
  const frameLocator = page.frameLocator("#editor-tistory_ifr");
  const body = frameLocator.locator("body#tinymce").first();
  await body.waitFor({ state: "visible", timeout });
  const handle = await page.locator("#editor-tistory_ifr").elementHandle({ timeout });
  const frame = await handle.contentFrame();
  if (!frame) throw new Error("Tistory editor iframe is not available.");
  return frame;
}

async function hasEditorReady(page) {
  const titleReady = await page.locator("#post-title-inp").first().isVisible({ timeout: 1000 }).catch(() => false);
  if (!titleReady) return false;
  return page.locator("#editor-tistory_ifr").first().isVisible({ timeout: 1000 }).catch(() => false);
}

async function completeLoginIfNeeded(page, options, log) {
  if (await hasEditorReady(page)) return false;
  const kakaoButton = page.locator(".link_kakao_id, a:has-text('카카오계정으로 로그인')").first();
  if (await kakaoButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    if (options.failOnLoginRequired === true) {
      throw sessionExpiredError("Tistory Kakao login is required.");
    }
    log("Tistory Kakao login is required. Please complete account selection or security verification in the opened browser.", "warn");
    await safeClickLocator(kakaoButton);
  }

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await hasEditorReady(page)) return true;
    await sleep(1000);
  }
  throw sessionExpiredError("Tistory login was not completed within the allowed time.");
}

async function prepareTistoryNewPost(options = {}) {
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    throw new Error("playwright-core is required for Tistory browser automation.");
  }
  const log = options.log || (() => {});
  const browserProfileDir = options.browserProfileDir
    || path.join(options.runtimeRoot || process.cwd(), "tistory-browser-profile");
  fs.mkdirSync(browserProfileDir, { recursive: true });
  markChromeProfileClean(browserProfileDir);

  const context = await chromium.launchPersistentContext(browserProfileDir, chromeLaunchOptions({
    slowMo: 80,
    viewport: { width: 1366, height: 900 }
  }));
  let page = activePage(context, null) || await context.newPage();
  const newPostUrl = newPostUrlFor(options);
  log(`Tistory editor target URL: ${newPostUrl}`);
  page = await gotoResilient(page, newPostUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await completeLoginIfNeeded(page, options, log);
  await page.locator("#post-title-inp").waitFor({ state: "visible", timeout: 60000 });
  await page.locator("#editor-tistory_ifr").waitFor({ state: "visible", timeout: 60000 });
  return { context, page, browserProfileDir };
}

function stripDuplicateTitleLine(article, title) {
  const lines = String(article || "").split(/\r?\n/);
  const normalizedTitle = String(title || "").trim();
  while (lines.length && !lines[0].trim()) lines.shift();
  if (normalizedTitle && lines[0] && lines[0].trim() === normalizedTitle) lines.shift();
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
      if (section) blocks.push({ type: "section", text: section[1].trim() });
      else blocks.push({ type: "paragraph", text: paragraph });
    }
  }
  return blocks;
}

async function focusEditorBody(page) {
  const frame = await getEditorFrame(page);
  const body = frame.locator("body#tinymce").first();
  await safeClickLocator(body);
  await page.keyboard.press("End").catch(() => {});
  return frame;
}

async function chooseQuoteStyle(page, styleNumber, log) {
  const quoteButtonSelectors = [
    "button:has(.mce-i-blockquote)",
    "#mceu_13-open"
  ];
  const styleSelectors = styleNumber === 1
    ? ["[role='menuitem']:has(.mce-i-blockquote-style1)", "[role='menuitem']:has-text('인용1')", "#mceu_37"]
    : ["[role='menuitem']:has(.mce-i-blockquote-style2)", "[role='menuitem']:has-text('인용2')", "#mceu_38"];

  const button = await findVisibleLocator(page, quoteButtonSelectors, 8000);
  await safeClickLocator(button);
  const option = await findVisibleLocator(page, styleSelectors, 8000).catch(() => null);
  if (!option) {
    log(`Tistory quote style ${styleNumber} was not found. Falling back to normal paragraph.`, "warn");
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await safeClickLocator(option);
  await sleep(300);
  return true;
}

async function insertQuoteBlock(page, text, styleNumber, log) {
  await focusEditorBody(page);
  const styled = await chooseQuoteStyle(page, styleNumber, log);
  await page.keyboard.type(String(text || ""), { delay: 30 });
  await page.keyboard.press("End").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  if (!styled) log("Tistory quote fallback input completed.", "warn");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitKoreanSentences(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return [];
  return value
    .split(/(?<=[.!?。！？]|(?:다|요|죠|임|음|함|됨)\.)(?=\s+)/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function paragraphHtml(text, breakSentences = true) {
  const sentences = breakSentences ? splitKoreanSentences(text) : [];
  const lines = sentences.length > 1 ? sentences : [String(text || "").trim()].filter(Boolean);
  return `${lines.map((line) => `<p data-ke-size="size16">${escapeHtml(line)}</p>`).join("")}<p data-ke-size="size16"><br></p>`;
}

function quoteHtml(text, styleNumber) {
  const style = styleNumber === 1 ? "style1" : "style2";
  return `<blockquote data-ke-style="${style}"><p data-ke-size="size16">${escapeHtml(text)}</p></blockquote><p data-ke-size="size16"><br></p>`;
}

async function insertEditorHtml(page, html) {
  const frame = await getEditorFrame(page);
  await frame.evaluate((insertHtml) => {
    const body = document.querySelector("body#tinymce");
    if (!body) throw new Error("Tistory editor body is not available.");
    const isEmpty = !body.textContent.trim() && body.querySelectorAll("figure,img").length === 0;
    if (isEmpty) body.innerHTML = "";
    body.insertAdjacentHTML("beforeend", insertHtml);
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const selection = body.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    body.focus();
    body.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertHTML",
      data: insertHtml
    }));
    body.dispatchEvent(new Event("change", { bubbles: true }));
    let editor = null;
    try {
      editor = window.parent?.tinymce?.get?.("editor-tistory") || window.parent?.tinymce?.activeEditor;
    } catch {
      editor = null;
    }
    if (editor) {
      editor.undoManager?.add?.();
      editor.setDirty?.(true);
      editor.fire?.("input");
      editor.fire?.("change");
    }
  }, html);
}

async function insertStructuredQuoteBlock(page, text, styleNumber) {
  await insertEditorHtml(page, quoteHtml(text, styleNumber));
}

async function insertImageByButton(page, filePath) {
  let chooserPromise = page.waitForEvent("filechooser", { timeout: 1500 }).catch(() => null);
  const button = await findVisibleLocator(page, [
    "#mceu_0-open",
    "button:has(.mce-i-image)",
    "button:has(#attach-image-text)",
    "button:has-text('사진')"
  ], 15000);
  await safeClickLocator(button);
  let chooser = await chooserPromise;
  if (!chooser) {
    const menuItem = await findVisibleLocator(page, [
      "#attach-image-text",
      "[role='menuitem']:has(#attach-image-text)",
      ".mce-menu-item:has(#attach-image-text)"
    ], 5000);
    chooserPromise = page.waitForEvent("filechooser", { timeout: 10000 }).catch(() => null);
    await safeClickLocator(menuItem);
    chooser = await chooserPromise;
  }
  if (chooser) {
    await chooser.setFiles(filePath);
  } else {
    const fileInput = page.locator("input[type='file']").last();
    if (await fileInput.count().catch(() => 0)) {
      await fileInput.setInputFiles(filePath, { timeout: 5000 });
    } else {
      throw new Error("Tistory image file input was not opened.");
    }
  }
  await sleep(2000);
}

async function insertArticleWithImages(page, article, bodyImages, options, log) {
  const blocks = splitArticleBlocks(article);
  log("Tistory body writing start");
  await insertStructuredQuoteBlock(page, options.title || "", 1);
  if (options.titleImagePath) {
    await focusEditorBody(page);
    await insertImageByButton(page, options.titleImagePath);
    await insertEditorHtml(page, '<p data-ke-size="size16"><br></p>');
  }

  for (const block of blocks) {
    if (block.type === "paragraph") {
      await insertEditorHtml(page, paragraphHtml(block.text, options.breakSentencesInBody !== false));
      continue;
    }
    if (block.type === "section") {
      await insertStructuredQuoteBlock(page, block.text, 2);
      continue;
    }
    const image = (bodyImages || []).find((item) => Number(item.sequence) === block.sequence);
    if (!image?.path) {
      log(`Tistory body image ${block.sequence} file is missing. Skipping.`, "warn");
      continue;
    }
    await focusEditorBody(page);
    await insertImageByButton(page, image.path);
    await insertEditorHtml(page, '<p data-ke-size="size16"><br></p>');
  }
  log("Tistory body writing complete");
}

function sanitizeTistoryTag(value) {
  return String(value || "")
    .replace(/^#+/, "")
    .replace(/[,\n\r\t]+/g, " ")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

const TISTORY_TAG_LIMIT = 8;
const TISTORY_TAG_INPUT_SELECTORS = [
  "#tagText",
  ".editor_tag input[name='tagText']",
  ".editor_tag input[title='태그']",
  "input[placeholder='태그입력']"
];

async function inputTistoryTags(page, tags, log) {
  const cleanTags = (Array.isArray(tags) ? tags : [])
    .flatMap((tag) => String(tag || "").split(/[,\n#]+/))
    .map(sanitizeTistoryTag)
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, TISTORY_TAG_LIMIT);
  if (!cleanTags.length) return;

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  const input = await findVisibleLocator(page, TISTORY_TAG_INPUT_SELECTORS, 12000);
  await safeClickLocator(input);
  await input.fill("");
  let enteredCount = 0;
  for (const tag of cleanTags) {
    const activeInput = await findVisibleLocator(page, TISTORY_TAG_INPUT_SELECTORS, 3000).catch(() => null);
    if (!activeInput) {
      log(`Tistory tag input is no longer available after ${enteredCount} tags.`, "warn");
      break;
    }
    await safeClickLocator(activeInput);
    const typed = await activeInput.type(tag, { delay: 10, timeout: 5000 }).then(() => true).catch((error) => {
      log(`Tistory tag input stopped at ${enteredCount}/${cleanTags.length}: ${error.message}`, "warn");
      return false;
    });
    if (!typed) break;
    await activeInput.press("Comma", { timeout: 3000 }).catch(async () => {
      await activeInput.type(",", { delay: 10, timeout: 3000 }).catch(() => {});
    });
    enteredCount += 1;
    await page.waitForTimeout(80).catch(() => {});
  }
  const finalInput = await findVisibleLocator(page, TISTORY_TAG_INPUT_SELECTORS, 1500).catch(() => null);
  const remainingValue = finalInput ? await finalInput.inputValue().catch(() => "") : "";
  if (finalInput && remainingValue.trim()) {
    await finalInput.press("Enter").catch(() => {});
  }
  if (finalInput) {
    await finalInput.evaluate((node) => {
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      node.blur();
    }).catch(() => {});
  }
  await page.waitForTimeout(500).catch(() => {});
  log(`Tistory tags input complete: ${enteredCount}/${cleanTags.length}`);
}

function normalizeCategoryText(value) {
  return String(value || "")
    .replace(/^[-\s]+/, "")
    .replace(/\s+/g, "")
    .replace(/\u2026/g, "")
    .trim();
}

async function selectCategory(page, category, log) {
  const target = normalizeCategoryText(category);
  if (!target) return false;
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  const button = await findVisibleLocator(page, ["#category-btn", "button[aria-controls='category-list']"], 10000);
  await safeClickLocator(button);
  const options = await page.locator("#category-list [role='option'], [role='listbox'] [role='option']").all();
  for (const option of options) {
    const label = await option.getAttribute("aria-label").catch(() => "") || await option.innerText().catch(() => "");
    const normalized = normalizeCategoryText(label);
    if (normalized === target || target.includes(normalized) || normalized.includes(target)) {
      await safeClickLocator(option);
      log(`Tistory category selected: ${label}`);
      return true;
    }
  }
  log(`Tistory category was not found: ${category}`, "warn");
  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

async function applyPublishVisibility(page, options) {
  const visibility = String(options.publishVisibility || (options.publishPrivate ? "private" : "public"));
  const selector = visibility === "public" ? "#open20" : "#open0";
  const radio = page.locator(selector).first();
  if (await radio.isVisible({ timeout: 5000 }).catch(() => false)) {
    await radio.check({ force: true });
  }
}

async function applyPublishSchedule(page, options, log) {
  if (String(options.publishScheduleMode || "now") !== "reserve") return;
  const reserveButtons = page.locator("button.btn_date");
  const count = await reserveButtons.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const button = reserveButtons.nth(index);
    const text = await button.innerText({ timeout: 500 }).catch(() => "");
    if (/\uC608\uC57D/.test(text)) {
      await safeClickLocator(button);
      break;
    }
  }
  const reserveAt = new Date(Date.now() + Math.max(1, Number(options.reserveAfterHours || 3)) * 60 * 60 * 1000);
  const hour = String(reserveAt.getHours());
  const minute = String(Math.floor(reserveAt.getMinutes() / 10) * 10);
  await page.locator("#dateHour").fill(hour).catch(() => log("Tistory reserve hour input was not found.", "warn"));
  await page.locator("#dateMinute").fill(minute).catch(() => log("Tistory reserve minute input was not found.", "warn"));
}

async function clickFinalPublish(page, options, log) {
  const finalButton = await findVisibleLocator(page, "#publish-btn", 15000);
  const text = await finalButton.innerText({ timeout: 1000 }).catch(() => "");
  log(`Tistory final publish button: ${text || "publish"}`);
  await safeClickLocator(finalButton);
  const blogId = tistoryBlogId(options);
  await page.waitForURL((url) => {
    try {
      return url.hostname === `${blogId}.tistory.com` && /^\/manage\/posts\/?$/i.test(url.pathname);
    } catch {
      return false;
    }
  }, { timeout: 60000 });
}

async function publishToTistory(options = {}) {
  const log = options.log || (() => {});
  const ownsContext = !options.preparedContext;
  const prepared = options.preparedContext
    ? { context: options.preparedContext, page: options.preparedPage }
    : await prepareTistoryNewPost(options);
  const context = prepared.context;
  const page = prepared.page && !prepared.page.isClosed() ? prepared.page : activePage(context, null);
  try {
    await gotoResilient(page, newPostUrlFor(options), { waitUntil: "domcontentloaded", timeout: 60000 });
    await completeLoginIfNeeded(page, options, log);
    const titleInput = await findVisibleLocator(page, "#post-title-inp", 30000);
    await titleInput.fill(String(options.title || ""));
    await selectCategory(page, options.category, log);
    await insertArticleWithImages(
      page,
      stripDuplicateTitleLine(options.article, options.title),
      options.bodyImages || [],
      {
        title: options.title,
        titleImagePath: options.titleImagePath,
        breakSentencesInBody: options.breakSentencesInBody
      },
      log
    );
    await inputTistoryTags(page, options.tags || [], log);
    const publishLayerButton = await findVisibleLocator(page, "#publish-layer-btn", 15000);
    await safeClickLocator(publishLayerButton);
    await applyPublishVisibility(page, options);
    await applyPublishSchedule(page, options, log);
    await clickFinalPublish(page, options, log);
    log("Tistory publish complete");
  } finally {
    if (ownsContext) await context.close().catch(() => {});
  }
}

async function checkTistorySession(options = {}) {
  const prepared = await prepareTistoryNewPost(options);
  const result = {
    status: "valid",
    reason: "tistory_editor_available",
    url: prepared.page?.url?.() || newPostUrlFor(options),
    browserProfileDir: prepared.browserProfileDir
  };
  if (options.keepOpen === true) {
    return {
      ...result,
      preparedSession: prepared,
      page: prepared.page
    };
  }
  await prepared.context.close().catch(() => {});
  return result;
}

module.exports = {
  publishToTistory,
  checkTistorySession,
  _private: {
    tistoryBlogId,
    newPostUrlFor,
    postsUrlFor,
    splitArticleBlocks,
    normalizeCategoryText
  }
};
