const { _electron: electron } = require("playwright-core");
const electronExecutable = require("electron");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const userDataDir = path.resolve(__dirname, "..", "runtime", ".smoke-electron-profile");
  const accountStorePath = path.resolve(__dirname, "..", "runtime", "account-categories.json");
  const smokeAssetDir = path.resolve(__dirname, "..", "runtime", "account-assets", "acct_smoke_delete");
  const smokeSampleImagePath = path.join(smokeAssetDir, "sample.png");
  const accountStoreBackup = fs.existsSync(accountStorePath)
    ? fs.readFileSync(accountStorePath, "utf8")
    : null;
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log("Launching Electron...");
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: ["--disable-gpu", "--disable-software-rasterizer", `--user-data-dir=${userDataDir}`, "."],
    env: {
      ...process.env,
      BLOGAUTO_SKIP_CODEX_USAGE_REFRESH: "1"
    }
  });
  try {
    console.log("Waiting for first window...");
    const window = await Promise.race([
      app.firstWindow(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for Electron window.")), 20000))
    ]);
    console.log("Window opened.");
    await window.waitForLoadState("domcontentloaded");
    await window.waitForSelector("#jobForm", { timeout: 15000 });

    const checks = [
      ["title", "Naver Blog Automator"],
      ["naver id", "#naverId"],
      ["blog id", "#blogId"],
      ["password", "#naverPassword"],
      ["startup notice", "#startupNotice"],
      ["dismiss startup notice", "#dismissStartupNoticeButton"],
      ["add account", "#addAccountButton"],
      ["update account", "#updateAccountButton"],
      ["clear account form", "#clearAccountFormButton"],
      ["account sample preview", "#accountSampleImagePreview"],
      ["account sample choose", "#chooseAccountSampleImageButton"],
      ["account sample delete", "#deleteAccountSampleImageButton"],
      ["topic", "#topic"],
      ["account list", "#accountList"],
      ["category list", "#categoryList"],
      ["topic mode", "#topicMode"],
      ["publish visibility", "#publishVisibility"],
      ["publish schedule", "#publishScheduleMode"],
      ["main log", "#mainLogStream"],
      ["research log", "#researchLogStream"],
      ["writer log", "#writerLogStream"],
      ["selected title", "#selectedTitle"],
      ["category excluded topics", "#categoryExcludedTopics"],
      ["category publish purpose", "#categoryPublishPurpose"],
      ["category preferred tone", "#categoryPreferredTone"],
      ["category freshness level", "#categoryFreshnessLevel"],
      ["article", "#articlePreview"],
      ["image aspect ratio", "#imageAspectRatio"],
      ["image grid", "#imageGrid"],
      ["history", "#historyBody"],
      ["codex primary usage badge", "#codexPrimaryLimitBadge"],
      ["codex weekly usage badge", "#codexSecondaryLimitBadge"]
    ];

    for (const [name, selectorOrText] of checks) {
      if (name === "title") {
        const title = await window.title();
        if (!title.includes(selectorOrText)) {
          throw new Error(`Expected window title to include ${selectorOrText}, got ${title}`);
        }
        continue;
      }
      const count = await window.locator(selectorOrText).count();
      if (!count) {
        throw new Error(`Missing UI element: ${name}`);
      }
    }

    const passwordType = await window.locator("#naverPassword").getAttribute("type");
    if (passwordType !== "password") {
      throw new Error("Password field is not masked.");
    }
    if (await window.locator("#startupNotice").isVisible().catch(() => false)) {
      await window.evaluate(() => {
        window.localStorage.setItem("blogauto.startupNotice.dismissed.v2", "true");
        const notice = document.querySelector("#startupNotice");
        if (notice) notice.hidden = true;
      });
    }

    await window.evaluate(() => {
      const grid = document.querySelector("#imageGrid");
      if (!grid) return;
      grid.innerHTML = "";
      for (let index = 1; index <= 12; index += 1) {
        const card = document.createElement("div");
        card.className = "thumb";
        card.innerHTML = `
          <div style="height:90px;background:#dbeafe;border-radius:6px"></div>
          <span>IMAGE ${index}</span>
          <code class="image-path">runtime/image/test_${index}.png</code>
          <div class="thumb-actions"><button type="button">open</button><button type="button">show</button></div>
        `;
        grid.appendChild(card);
      }
    });
    const imagePanelScrollable = await window.locator(".image-panel").evaluate((element) => (
      element.scrollHeight > element.clientHeight
    ));
    if (!imagePanelScrollable) {
      throw new Error("Image preview panel is not scrollable with many images.");
    }

    const panelSelectors = [
      ".preview-panel",
      ".main-log-panel",
      ".research-log-panel",
      ".writer-log-panel",
      ".history-panel"
    ];
    for (const { width, height } of [
      { width: 1440, height: 900 },
      { width: 1280, height: 768 },
      { width: 1180, height: 900 },
      { width: 980, height: 900 }
    ]) {
      await window.setViewportSize({ width, height });
      await window.waitForTimeout(100);
      const layoutResult = await window.evaluate(({ selectors, requireVerticalFit }) => {
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        return selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return { selector, ok: false, reason: "missing" };
          const rect = element.getBoundingClientRect();
          const horizontalOk = rect.left >= -1 && rect.right <= viewportWidth + 1 && rect.width > 0;
          const verticalOk = !requireVerticalFit || (
            rect.top >= -1 && rect.bottom <= viewportHeight + 1 && rect.height > 0
          );
          return {
            selector,
            ok: horizontalOk && verticalOk,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            viewportWidth,
            viewportHeight
          };
        });
      }, { selectors: panelSelectors, requireVerticalFit: width > 980 });
      const badPanel = layoutResult.find((item) => !item.ok);
      if (badPanel) {
        throw new Error(`Panel overflows at ${width}x${height}: ${JSON.stringify(badPanel)}`);
      }
    }

    fs.mkdirSync(smokeAssetDir, { recursive: true });
    fs.writeFileSync(smokeSampleImagePath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64"
    ));
    await window.evaluate(async ({ sampleImagePath }) => {
      await window.blogAuto.saveAccountStore({
        selectedAccountId: "acct_smoke_delete",
        accounts: [{
          id: "acct_smoke_delete",
          label: "Smoke Delete Account",
          naverId: "smoke-delete",
          blogId: "smoke-blog",
          naverPassword: "",
          checked: true,
          sessionStatus: "unknown",
          sessionCheckedAt: "",
          sampleImagePath,
          sampleImageHash: "smokehash",
          sampleImageUpdatedAt: new Date().toISOString(),
          imageStylePrompt: "smoke custom image style",
          imageStylePromptUpdatedAt: new Date().toISOString(),
          imageStylePromptStatus: "ready",
          imageStylePromptSourceImageHash: "smokehash",
          imageStylePromptError: "",
          categories: [{
            id: "cat_smoke_delete",
            name: "Smoke Category",
            keyword: "smoke keyword",
            checked: true
          }]
        }]
      });
    }, { sampleImagePath: smokeSampleImagePath });
    await window.waitForSelector(".account-row");
    const rowSessionButtons = await window.locator(".account-row [data-action='session']").count();
    if (!rowSessionButtons) {
      throw new Error("Account row session check button is missing.");
    }
    await window.locator("#toggleAccountManagerButton").click();
    await window.locator(".account-row").filter({ hasText: "Smoke Delete Account" }).click();
    const samplePreviewImages = await window.locator("#accountSampleImagePreview img").count();
    if (!samplePreviewImages) {
      throw new Error("Account sample image preview did not render.");
    }
    const autoRetryCalls = await window.evaluate(async () => {
      if (typeof window.startAutoPublishing !== "function") {
        throw new Error("startAutoPublishing is not available for renderer smoke test.");
      }
      const originalHooks = window.__blogAutoTestHooks;
      const originalDelayMinutes = document.querySelector("#repeatTermMinutes")?.value || "60";
      let calls = 0;
      window.__blogAutoTestHooks = {
        ...(originalHooks || {}),
        startJob: async () => {
          calls += 1;
          return calls < 3
            ? { status: "failed", reason: "research blocked in smoke test" }
            : { status: "codex_usage_limit" };
        }
      };
      const repeatTerm = document.querySelector("#repeatTermMinutes");
      if (repeatTerm) repeatTerm.value = "0";
      try {
        await window.startAutoPublishing();
      } finally {
        if (originalHooks) {
          window.__blogAutoTestHooks = originalHooks;
        } else {
          delete window.__blogAutoTestHooks;
        }
        if (repeatTerm) repeatTerm.value = originalDelayMinutes;
      }
      return calls;
    });
    if (autoRetryCalls !== 3) {
      throw new Error(`Auto publishing did not retry failed target 3 times, got ${autoRetryCalls}.`);
    }
    const researchRetryCalls = await window.evaluate(async () => {
      const originalHooks = window.__blogAutoTestHooks;
      const originalDelayMinutes = document.querySelector("#repeatTermMinutes")?.value || "60";
      let calls = 0;
      window.__blogAutoTestHooks = {
        ...(originalHooks || {}),
        startJob: async () => {
          calls += 1;
          if (calls >= 2) {
            window.setTimeout(() => document.querySelector("#stopAutoButton")?.click(), 0);
          }
          return {
            status: "failed",
            reason: "research blocked in smoke test",
            failurePhase: "research"
          };
        }
      };
      const repeatTerm = document.querySelector("#repeatTermMinutes");
      if (repeatTerm) repeatTerm.value = "0";
      try {
        await window.startAutoPublishing();
      } finally {
        if (originalHooks) {
          window.__blogAutoTestHooks = originalHooks;
        } else {
          delete window.__blogAutoTestHooks;
        }
        if (repeatTerm) repeatTerm.value = originalDelayMinutes;
      }
      return calls;
    });
    if (researchRetryCalls !== 2) {
      throw new Error(`Research-stage auto retry should stop after 2 attempts, got ${researchRetryCalls}.`);
    }
    await window.locator("#accountLabel").fill("Smoke Edited Account");
    await window.locator("#updateAccountButton").click();
    await window.waitForFunction(() => (
      [...document.querySelectorAll(".account-row")]
        .some((row) => row.textContent.includes("Smoke Edited Account"))
    ));
    window.on("dialog", (dialog) => dialog.accept());
    await window.locator(".account-row").filter({ hasText: "Smoke Edited Account" }).locator("[data-action='delete']").click();
    await window.waitForFunction(() => (
      [...document.querySelectorAll(".account-row")]
        .every((row) => !row.textContent.includes("Smoke Edited Account"))
    ));

    console.log("Electron smoke test passed.");

  } finally {
    await app.close();
    if (accountStoreBackup === null) {
      fs.rmSync(accountStorePath, { force: true });
    } else {
      fs.writeFileSync(accountStorePath, accountStoreBackup, "utf8");
    }
    fs.rmSync(smokeAssetDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
