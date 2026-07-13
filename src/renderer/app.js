const state = {
  currentJobId: "",
  running: false,
  autoRunning: false,
  autoPausedForSession: false,
  autoWaitingSessionAccountId: "",
  autoResumeAccountId: "",
  autoPendingSessionTarget: null,
  saveTimer: null,
  autoDelayWake: null,
  tokenTotal: 0,
  codexRateLimits: null,
  chrome: { available: true, path: "" },
  accountStore: { selectedAccountId: "", accounts: [] },
  tistorySessionStatus: "unknown",
  accountManagerOpen: false,
  categoryManagerOpen: false,
  historyModalOpen: false,
  draggingAccountId: "",
  draggingCategoryId: "",
  editingCategoryId: ""
};

const $ = (selector) => document.querySelector(selector);
const DEFAULT_NAVER_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={query}";
const DEFAULT_GOOGLE_SEARCH_URL = "https://www.google.com/search?q={query}&num=20&hl=ko";
const STARTUP_NOTICE_KEY = "blogauto.startupNotice.dismissed.v2";
const DEFAULT_AGENT_MODELS = {
  main: "high",
  research: "high",
  writer: "high",
  image: "medium"
};
const AGENT_MODEL_SELECTORS = {
  main: "#mainAgentModel",
  research: "#researchAgentModel",
  writer: "#writerAgentModel",
  image: "#imageWorkerModel"
};
const VALID_AGENT_MODEL_VALUES = new Set(["low", "medium", "high", "xhigh"]);
const AUTO_TARGET_MAX_ATTEMPTS = 3;
const AUTO_RESEARCH_MAX_ATTEMPTS = 2;
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ASPECT_RATIOS = new Set([DEFAULT_IMAGE_ASPECT_RATIO, "9:16", "1:1"]);

function normalizeImageAspectRatio(value) {
  const normalized = String(value || "").trim();
  return IMAGE_ASPECT_RATIOS.has(normalized) ? normalized : DEFAULT_IMAGE_ASPECT_RATIO;
}

function normalizeSearchProvider(value, fallback = "naver") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["naver", "google"].includes(normalized) ? normalized : fallback;
}

function normalizeSearchChannel(value, fallback = "blog") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["blog", "news", "web"].includes(normalized) ? normalized : fallback;
}

function searchChannelLabel(value) {
  const channel = normalizeSearchChannel(value);
  if (channel === "news") return "검색: 뉴스";
  if (channel === "web") return "검색: 웹";
  return "검색: 블로그";
}

function fallbackSearchProviderFor(primary) {
  return normalizeSearchProvider(primary, "naver") === "google" ? "naver" : "google";
}

function categorySearchProviders(category = {}) {
  const primarySearchProvider = normalizeSearchProvider(category?.primarySearchProvider, "naver");
  let fallbackSearchProvider = normalizeSearchProvider(
    category?.fallbackSearchProvider,
    fallbackSearchProviderFor(primarySearchProvider)
  );
  if (fallbackSearchProvider === primarySearchProvider) {
    fallbackSearchProvider = fallbackSearchProviderFor(primarySearchProvider);
  }
  return { primarySearchProvider, fallbackSearchProvider };
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function selectedAccount() {
  return state.accountStore.accounts.find((account) => account.id === state.accountStore.selectedAccountId)
    || state.accountStore.accounts[0]
    || null;
}

function setRunState(status, detail = "") {
  const badge = $("#runState");
  const classMap = {
    success: "success",
    generated: "success",
    failed: "danger",
    codex_usage_limit: "danger",
    session_expired: "danger",
    duplicate_retry: "warning",
    publishing: "info",
    generating: "info"
  };
  const labelMap = {
    success: "성공",
    generated: "생성",
    failed: "실패",
    codex_usage_limit: "한도초과",
    session_expired: "세션만료",
    duplicate_retry: "중복",
    publishing: "발행",
    generating: "생성중"
  };
  badge.className = `badge ${classMap[status] || "info"}`;
  badge.textContent = detail && detail !== status ? detail : (labelMap[status] || status || "대기");
}

function setTistoryTestButtonDisabled(disabled) {
  const button = $("#tistoryTestButton");
  if (button) button.disabled = disabled;
}

function addLog(payload) {
  const streamMap = {
    main: "#mainLogStream",
    research: "#researchLogStream",
    writer: "#writerLogStream",
    image: "#mainLogStream"
  };
  const stream = $(streamMap[payload.agent] || streamMap.main);
  if (!stream) return;
  const line = document.createElement("div");
  line.className = `log-line ${payload.level || "info"}`;
  const time = payload.at ? new Date(payload.at).toLocaleTimeString() : new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${payload.message}`;
  stream.appendChild(line);
  stream.scrollTop = stream.scrollHeight;
}

function shouldRetryAutoResult(result) {
  const status = String(result?.status || "").toLowerCase();
  return !["success", "generated", "codex_usage_limit", "session_expired"].includes(status);
}

function autoAttemptLimitForResult(result) {
  return String(result?.failurePhase || "").toLowerCase() === "research"
    ? AUTO_RESEARCH_MAX_ATTEMPTS
    : AUTO_TARGET_MAX_ATTEMPTS;
}

function autoResultReason(result) {
  return String(result?.reason || result?.failureReason || result?.status || "unknown").trim();
}

function keywordLanePhrasesFromResult(result) {
  const lane = result?.keywordLane || {};
  return [
    lane.topicLane,
    ...(Array.isArray(lane.selectedKeywordPhrases) ? lane.selectedKeywordPhrases : [])
  ]
    .map((phrase) => String(phrase || "").trim())
    .filter(Boolean);
}

function runAutoStartJob(form) {
  const testStartJob = window.__blogAutoTestHooks?.startJob;
  if (typeof testStartJob === "function") {
    return testStartJob(form);
  }
  return window.blogAuto.startJob(form);
}

function clearAgentLogs() {
  ["#mainLogStream", "#researchLogStream", "#writerLogStream"].forEach((selector) => {
    const stream = $(selector);
    if (stream) stream.innerHTML = "";
  });
}

function formatTokens(total) {
  const value = Number(total || 0);
  return `${value.toLocaleString()} tokens`;
}

function setTokenTotal(total) {
  state.tokenTotal = Number(total || 0);
  $("#tokenBadge").textContent = `누적 ${formatTokens(state.tokenTotal)}`;
}

function formatPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "-";
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function limitBadgeClass(limitWindow) {
  const remaining = Number(limitWindow?.remainingPercent);
  if (!Number.isFinite(remaining)) return "badge limit unknown";
  if (remaining <= 10) return "badge limit danger";
  if (remaining <= 25) return "badge limit warning";
  return "badge limit";
}

function codexLimitWindows(rateLimits) {
  return [rateLimits?.primary, rateLimits?.secondary]
    .filter((limitWindow) => limitWindow && typeof limitWindow === "object");
}

function weeklyCodexLimitWindow(rateLimits) {
  const windows = codexLimitWindows(rateLimits);
  const weekly = windows.find((limitWindow) => Number(limitWindow.windowMinutes) === 10080);
  if (weekly) return weekly;
  return windows
    .slice()
    .sort((left, right) => Number(right.windowMinutes || 0) - Number(left.windowMinutes || 0))[0] || null;
}

function renderCodexRateLimits(status = "") {
  const weeklyBadge = $("#codexWeeklyLimitBadge");
  if (!weeklyBadge) return;

  const rateLimits = state.codexRateLimits || {};
  const weekly = weeklyCodexLimitWindow(rateLimits);

  weeklyBadge.className = limitBadgeClass(weekly);
  weeklyBadge.textContent = `주간 잔량 ${formatPercent(weekly?.remainingPercent)}`;

  if (status === "checking" && !weekly) {
    weeklyBadge.textContent = "주간 확인 중";
  }
  if (status === "failed" && !weekly) {
    weeklyBadge.textContent = "주간 확인 실패";
  }
}

function setCodexRateLimits(rateLimits, status = "") {
  if (rateLimits && typeof rateLimits === "object") {
    state.codexRateLimits = rateLimits;
  }
  renderCodexRateLimits(status);
}

function statusBadge(status) {
  const classMap = {
    success: "success",
    generated: "success",
    failed: "danger",
    codex_usage_limit: "danger",
    session_expired: "danger",
    duplicate_retry: "warning",
    publishing: "info",
    generating: "info"
  };
  const labelMap = {
    success: "성공",
    generated: "생성",
    failed: "실패",
    codex_usage_limit: "한도초과",
    session_expired: "세션만료",
    duplicate_retry: "중복",
    publishing: "발행",
    generating: "생성중"
  };
  return `<span class="badge ${classMap[status] || "info"}">${labelMap[status] || status || "대기"}</span>`;
}

function sessionBadge(account) {
  const status = account.sessionStatus || "unknown";
  const className = status === "valid" ? "success" : status === "expired" ? "danger" : "warning";
  const label = status === "valid" ? "정상" : status === "expired" ? "세션만료" : "미확인";
  return `<span class="badge ${className}">${label}</span>`;
}

function updateSessionNotice() {
  const notice = $("#sessionNotice");
  const text = $("#sessionNoticeText");
  if (!notice || !text) return;

  const accounts = state.accountStore.accounts || [];
  const needsLogin = !accounts.length || accounts.some((account) => account.sessionStatus !== "valid");
  if (!needsLogin) {
    notice.hidden = true;
    return;
  }

  if (!accounts.length) {
    text.textContent = "처음 실행 상태입니다. 계정을 추가한 뒤 계정별 세션 확인을 눌러 브라우저에서 로그인을 완료해 주세요.";
  } else {
    const names = accounts
      .filter((account) => account.sessionStatus !== "valid")
      .map((account) => account.label || account.naverId || "Naver 계정")
      .join(", ");
    text.textContent = `로그인이 필요한 계정: ${names}. 계정별로 선택 후 세션 확인을 진행해 주세요.`;
  }
  notice.hidden = false;
}

function wakeAutoDelay() {
  const wake = state.autoDelayWake;
  if (typeof wake === "function") {
    state.autoDelayWake = null;
    wake();
  }
}

function signalAutoSessionResume(accountId) {
  const verifiedAccountId = String(accountId || "");
  if (state.autoWaitingSessionAccountId && state.autoWaitingSessionAccountId === verifiedAccountId) {
    state.autoResumeAccountId = verifiedAccountId;
    wakeAutoDelay();
  }
}

async function checkAccountSession(account, options = {}) {
  if (!account) return;
  const resumeAuto = options.resumeAuto !== false;
  const startAuto = options.startAuto !== false;
  setRunState("generating", "로그인 완료 대기 중");
  addLog({
    level: "info",
    message: `${account.label || account.naverId} 계정의 브라우저가 열리면 로그인 완료까지 진행해 주세요.`,
    at: new Date().toISOString()
  });
  try {
    const result = await window.blogAuto.checkAccountSession(account.id, {
      includeTistorySession: options.includeTistorySession !== false
    });
    const currentAccount = state.accountStore.accounts.find((item) => item.id === account.id);
    const tistoryValid = !result.tistorySession || result.tistorySession.status === "valid";
    if (result.tistorySession) {
      state.tistorySessionStatus = result.tistorySession.status || "unknown";
      addLog({
        level: tistoryValid ? "info" : "warn",
        message: tistoryValid ? "Tistory session check complete." : `Tistory session check failed: ${result.tistorySession.reason || result.tistorySession.status}`,
        at: new Date().toISOString()
      });
    }
    if (result.status === "valid") {
      if (currentAccount) currentAccount.sessionStatus = "valid";
      renderAccounts();
      setRunState("generated", "세션 정상");
      const verifiedAccountId = currentAccount?.id || account.id || "";
      if (resumeAuto && state.autoRunning && state.autoWaitingSessionAccountId === verifiedAccountId) {
        addLog({
          level: "info",
          message: "현재 대기 중인 계정의 세션확인이 완료되어 자동 작업을 바로 이어갑니다.",
          at: new Date().toISOString()
        });
        signalAutoSessionResume(verifiedAccountId);
      } else if (resumeAuto && state.autoRunning && state.autoWaitingSessionAccountId) {
        addLog({
          level: "info",
          message: "세션확인은 완료되었지만 현재 대기 중인 계정이 아니므로 대기 작업은 유지합니다.",
          at: new Date().toISOString()
        });
      } else if (startAuto && !state.autoRunning && state.autoPendingSessionTarget?.accountId === verifiedAccountId) {
        const pending = state.autoPendingSessionTarget;
        addLog({
          level: "info",
          message: `${pending.accountLabel || account.naverId} / ${pending.categoryName} 대기 작업을 다시 시작합니다.`,
          at: new Date().toISOString()
        });
        const startKey = pending.key;
        state.autoPendingSessionTarget = null;
        window.setTimeout(() => {
          startAutoPublishing(startKey).catch((error) => {
            state.running = false;
            state.autoRunning = false;
            state.autoPausedForSession = false;
            state.autoWaitingSessionAccountId = "";
            state.autoResumeAccountId = "";
            state.autoPendingSessionTarget = null;
            addLog({ level: "error", message: error.message, at: new Date().toISOString() });
            setRunState("failed", "실패");
          });
        }, 0);
      } else {
        const autoTarget = startAuto && $("#topicMode").value === "auto" ? firstAutoTargetForAccount(verifiedAccountId) : null;
        if (autoTarget && !state.running && !state.autoRunning) {
          const startKey = autoTargetKey(autoTarget);
          addLog({
            level: "info",
            message: `${autoTarget.account.label || autoTarget.account.naverId} / ${autoTarget.category.name} 자동 작업을 바로 시작합니다.`,
            at: new Date().toISOString()
          });
          window.setTimeout(() => {
            startAutoPublishing(startKey).catch((error) => {
              state.running = false;
              state.autoRunning = false;
              state.autoPausedForSession = false;
              state.autoWaitingSessionAccountId = "";
              state.autoResumeAccountId = "";
    state.autoPendingSessionTarget = null;
    $("#startButton").disabled = false;
    setTistoryTestButtonDisabled(false);
    $("#stopAutoButton").disabled = true;
              addLog({ level: "error", message: error.message, at: new Date().toISOString() });
              setRunState("failed", "실패");
            });
          }, 0);
        } else {
          addLog({
            level: "info",
            message: "계정 세션확인이 완료되었습니다. 작업 시작을 누르면 이 세션으로 바로 진행합니다.",
            at: new Date().toISOString()
          });
        }
      }
    } else if (result.status === "expired") {
      if (currentAccount) currentAccount.sessionStatus = "expired";
      renderAccounts();
      setRunState("session_expired", "세션만료");
    } else {
      if (currentAccount) currentAccount.sessionStatus = "unknown";
      renderAccounts();
      setRunState("failed", "세션 확인 실패");
    }
  } catch (error) {
    addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    setRunState("failed", "세션 확인 실패");
  }
}

async function checkSelectedAccountSessions() {
  if (state.running || state.autoRunning) {
    addLog({ level: "warn", message: "작업 실행 중에는 세션일괄확인을 시작할 수 없습니다.", at: new Date().toISOString() });
    return;
  }
  const button = $("#bulkSessionCheckButton");
  const accounts = (state.accountStore.accounts || []).filter((account) => account.checked !== false);
  if (!accounts.length) {
    addLog({ level: "warn", message: "세션을 확인할 체크된 계정이 없습니다.", at: new Date().toISOString() });
    return;
  }

  if (button) button.disabled = true;
  addLog({ level: "info", message: `체크된 계정 ${accounts.length}개의 세션을 순차 확인합니다.`, at: new Date().toISOString() });
  try {
    const form = collectForm();
    if (form.publishToTistoryAfterNaver && form.tistoryBlogId) {
      try {
        const tistoryResult = await window.blogAuto.checkTistorySession(form.tistoryBlogId);
        state.tistorySessionStatus = tistoryResult.status || "unknown";
        addLog({
          level: tistoryResult.status === "valid" ? "info" : "warn",
          message: tistoryResult.status === "valid" ? "Tistory session check complete." : `Tistory session check failed: ${tistoryResult.reason || tistoryResult.status}`,
          at: new Date().toISOString()
        });
      } catch (error) {
        state.tistorySessionStatus = "expired";
        addLog({ level: "warn", message: `Tistory session check failed: ${error.message}`, at: new Date().toISOString() });
      }
    }
    for (const account of accounts) {
      addLog({
        level: "info",
        message: `${account.label || account.naverId} 계정 세션 확인을 시작합니다.`,
        at: new Date().toISOString()
      });
      await checkAccountSession(account, { resumeAuto: false, startAuto: false, includeTistorySession: false });
    }
    addLog({ level: "info", message: "세션일괄확인이 완료되었습니다.", at: new Date().toISOString() });
  } finally {
    if (button) button.disabled = false;
  }
}

function showStartupNoticeIfNeeded() {
  const notice = $("#startupNotice");
  if (!notice) return;
  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(STARTUP_NOTICE_KEY) === "true";
  } catch {
    dismissed = false;
  }
  notice.hidden = dismissed && state.chrome.available !== false;
}

async function dismissStartupNotice() {
  const notice = $("#startupNotice");
  if (notice) notice.hidden = true;
  try {
    window.localStorage.setItem(STARTUP_NOTICE_KEY, "true");
  } catch {
    // Ignore storage failures; the notice can still be dismissed for this session.
  }
  if (state.chrome.available === false) {
    window.alert("Chrome이 설치되어 있지 않아 네이버 세션 확인과 블로그 발행을 진행할 수 없습니다. Chrome 설치 페이지를 연 뒤 프로그램을 종료합니다.");
    await window.blogAuto.openChromeInstallAndQuit();
  }
}

async function refreshCodexUsageOnStartup() {
  renderCodexRateLimits("checking");
  try {
    const usage = await window.blogAuto.refreshCodexUsage();
    if (usage?.rateLimits) {
      setCodexRateLimits(usage.rateLimits);
    } else if (!state.codexRateLimits) {
      renderCodexRateLimits();
    }
  } catch (error) {
    if (!state.codexRateLimits) {
      renderCodexRateLimits();
    }
  }
}

function renderHistory(history) {
  const body = $("#historyBody");
  const summary = $("#historySummary");
  const modal = $("#historyModal");
  const items = Array.isArray(history) ? history : [];

  if (modal) modal.hidden = !state.historyModalOpen;
  if (summary) summary.innerHTML = renderHistorySummary(items);

  body.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty history-empty";
    empty.textContent = "작업 기록이 없습니다.";
    body.appendChild(empty);
    return;
  }

  for (const item of items.slice(0, 20)) {
    const card = document.createElement("article");
    card.className = `history-card ${historyStatusClass(item.status)}`;
    const title = item.title || item.research_title || item.topic || "제목 없음";
    const meta = [
      item.category && `카테고리 ${item.category}`,
      item.keyword && `키워드 ${item.keyword}`,
      item.blog_id && `블로그 ${item.blog_id}`
    ].filter(Boolean).join(" · ");
    const detailRows = [
      ["주제", item.topic],
      ["선택 lane", item.selected_lane || item.lane || item.keyword_lane],
      ["검색어", item.search_query || item.query],
      ["Research 제목", item.research_title],
      ["검토 결과", item.final_verdict],
      ["실패 단계", item.failure_phase],
      ["근거 요약", item.source_summary],
      ["사유", item.reason]
    ].filter(([, value]) => String(value || "").trim());

    card.innerHTML = `
      <div class="history-card-top">
        ${statusBadge(item.status)}
        <span class="history-date">${escapeHtml(formatHistoryDate(item.create_at))}</span>
        <span class="history-token">${escapeHtml(formatTokens(item.token_total || 0))}</span>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p class="history-meta">${escapeHtml(meta || "작업 대상 정보 없음")}</p>
      <p class="history-reason">${escapeHtml(item.reason || item.source_summary || "기록된 사유가 없습니다.")}</p>
      <details class="history-details">
        <summary>상세 보기</summary>
        <dl>
          ${detailRows.map(([label, value]) => `
            <div>
              <dt>${escapeHtml(label)}</dt>
              <dd>${escapeHtml(value)}</dd>
            </div>
          `).join("")}
        </dl>
      </details>
    `;
    body.appendChild(card);
  }
}

function renderHistorySummary(items) {
  const total = items.length;
  const success = items.filter((item) => item.status === "success" || item.status === "generated").length;
  const failed = items.filter((item) => !["success", "generated"].includes(String(item.status || ""))).length;
  const latest = items[0];
  const latestTitle = latest ? (latest.title || latest.research_title || latest.topic || "제목 없음") : "기록 없음";
  const latestDate = latest ? formatHistoryDate(latest.create_at) : "-";
  return `
    <div class="history-metric">
      <strong>${escapeHtml(total)}</strong>
      <span>전체</span>
    </div>
    <div class="history-metric success">
      <strong>${escapeHtml(success)}</strong>
      <span>성공/생성</span>
    </div>
    <div class="history-metric danger">
      <strong>${escapeHtml(failed)}</strong>
      <span>확인 필요</span>
    </div>
    <div class="history-latest">
      <span>최근 작업</span>
      <strong>${escapeHtml(latestTitle)}</strong>
      <em>${escapeHtml(latestDate)}</em>
    </div>
  `;
}

function historyStatusClass(status) {
  const normalized = String(status || "");
  if (normalized === "success" || normalized === "generated") return "success";
  if (normalized === "duplicate_retry") return "warning";
  if (normalized === "publishing" || normalized === "generating") return "info";
  return "danger";
}

function formatHistoryDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function closeHistoryModal() {
  state.historyModalOpen = false;
  const modal = $("#historyModal");
  if (modal) modal.hidden = true;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderImages(images) {
  const grid = $("#imageGrid");
  grid.innerHTML = "";
  if (!images || images.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "생성된 이미지 파일이 없습니다. 아래 상태 메시지를 확인하세요.";
    grid.appendChild(empty);
    return;
  }

  for (const image of images) {
    const card = document.createElement("div");
    card.className = "thumb";
    card.title = image.path;
    card.innerHTML = `
      <img src="${image.url}" alt="${image.role === "title" ? "타이틀 이미지" : `본문 이미지 ${image.sequence}`}" />
      <span>${image.role === "title" ? "title" : `IMAGE ${image.sequence}`}</span>
      <code class="image-path">${escapeHtml(image.path)}</code>
      <div class="thumb-actions">
        <button type="button" data-action="open">열기</button>
        <button type="button" data-action="show">위치</button>
      </div>
    `;
    card.querySelector("[data-action='open']").addEventListener("click", () => window.blogAuto.openFile(image.path));
    card.querySelector("[data-action='show']").addEventListener("click", () => window.blogAuto.showFileInFolder(image.path));
    grid.appendChild(card);
  }
}

function renderImageNotes(imageNotes) {
  const notes = $("#imageNotes");
  notes.innerHTML = "";
  const usefulNotes = (imageNotes || []).filter(Boolean);
  for (const note of usefulNotes) {
    const item = document.createElement("div");
    item.className = note.includes("이미지") ? "note warn" : "note";
    item.textContent = note;
    notes.appendChild(item);
  }
}

function renderAccounts() {
  const list = $("#accountList");
  const manager = $("#accountManager");
  const toggle = $("#toggleAccountManagerButton");
  if (manager && toggle) {
    manager.classList.toggle("collapsed", !state.accountManagerOpen);
    toggle.textContent = state.accountManagerOpen ? "접기" : "펼치기";
  }
  list.innerHTML = "";
  if (!state.accountStore.accounts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "등록된 계정이 없습니다.";
    list.appendChild(empty);
    renderCategories();
    updateSessionNotice();
    return;
  }

  for (const account of state.accountStore.accounts) {
    const row = document.createElement("div");
    row.className = `account-row${account.id === state.accountStore.selectedAccountId ? " selected" : ""}`;
    row.dataset.accountId = account.id;
    row.innerHTML = `
      <button type="button" class="drag-handle account-drag-handle" draggable="true" aria-label="계정 순서 드래그" title="드래그해서 계정 순서 변경">⇅</button>
      <input class="list-check" type="checkbox" ${account.checked !== false ? "checked" : ""} aria-label="자동 발행 계정 선택" />
      <div class="account-main">
        <strong title="${escapeHtml(account.label || account.naverId || "Naver 계정")}">${escapeHtml(account.label || account.naverId || "Naver 계정")}</strong>
        <span title="${escapeHtml(account.naverId || "-")}">${escapeHtml(account.naverId || "-")}</span>
        <small>블로그 ${escapeHtml(account.blogId || account.naverId || "-")}</small>
        <small>카테고리 ${(account.categories || []).length}개</small>
      </div>
      <div class="account-actions">
        ${sessionBadge(account)}
        <button type="button" class="ghost small" data-action="session">세션확인</button>
        <button type="button" class="select-button small" data-action="select">${account.id === state.accountStore.selectedAccountId ? "선택됨" : "선택"}</button>
        <button type="button" class="ghost small danger-button" data-action="delete">삭제</button>
      </div>
    `;
    const dragHandle = row.querySelector(".account-drag-handle");
    dragHandle.addEventListener("click", (event) => event.stopPropagation());
    dragHandle.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      state.draggingAccountId = account.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", account.id);
    });
    dragHandle.addEventListener("dragend", (event) => {
      event.stopPropagation();
      state.draggingAccountId = "";
      row.classList.remove("dragging");
      list.querySelectorAll(".account-row.drag-over").forEach((item) => item.classList.remove("drag-over"));
    });
    row.addEventListener("dragover", (event) => {
      if (!state.draggingAccountId || state.draggingAccountId === account.id) return;
      event.preventDefault();
      row.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove("drag-over");
      const draggedId = state.draggingAccountId || event.dataTransfer.getData("text/plain");
      state.draggingAccountId = "";
      if (moveAccountBefore(draggedId, account.id)) {
        await persistAccountOrder();
      }
    });
    row.addEventListener("click", () => selectAccount(account.id));
    row.querySelector("input").addEventListener("click", (event) => {
      event.stopPropagation();
      account.checked = event.target.checked;
      saveAccountStoreNow();
    });
    row.querySelector("[data-action='select']").addEventListener("click", (event) => {
      event.stopPropagation();
      selectAccount(account.id);
    });
    row.querySelector("[data-action='session']").addEventListener("click", (event) => {
      event.stopPropagation();
      checkAccountSession(account);
    });
    row.querySelector("[data-action='delete']").addEventListener("click", async (event) => {
      event.stopPropagation();
      const label = account.label || account.naverId || "Naver 계정";
      if (!window.confirm(`${label} 계정을 삭제할까요? 이 계정에 등록된 카테고리도 함께 삭제됩니다.`)) {
        return;
      }
      state.accountStore.accounts = state.accountStore.accounts.filter((item) => item.id !== account.id);
      if (state.accountStore.selectedAccountId === account.id) {
        state.accountStore.selectedAccountId = state.accountStore.accounts[0]?.id || "";
        const nextAccount = selectedAccount();
        $("#accountLabel").value = nextAccount?.label || "";
        $("#naverId").value = nextAccount?.naverId || "";
        $("#blogId").value = nextAccount?.blogId || "";
        $("#naverPassword").value = nextAccount?.naverPassword || "";
      }
      await saveAccountStoreNow();
      addLog({
        agent: "main",
        level: "warn",
        message: `${label} 계정과 종속 카테고리를 삭제했습니다.`,
        at: new Date().toISOString()
      });
    });
    list.appendChild(row);
  }
  renderCategories();
  updateSessionNotice();
}

function renderCategories() {
  const account = selectedAccount();
  const list = $("#categoryList");
  const manager = $("#categoryManager");
  manager.classList.toggle("collapsed", !state.categoryManagerOpen);
  list.innerHTML = "";
  if (!account) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "카테고리를 등록할 계정을 먼저 선택하세요.";
    list.appendChild(empty);
    return;
  }
  if (!account.categories || !account.categories.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "등록된 카테고리가 없습니다.";
    list.appendChild(empty);
    return;
  }

  for (const [index, category] of account.categories.entries()) {
    const searchProviders = categorySearchProviders(category);
    const optionSummary = [
      category.excludedTopics ? `제외: ${category.excludedTopics}` : "",
      category.preferredTone ? `톤: ${category.preferredTone}` : "",
      category.freshnessLevel && category.freshnessLevel !== "auto" ? `최신성: ${category.freshnessLevel}` : "",
      searchChannelLabel(category.searchChannel),
      `Provider: ${searchProviders.primarySearchProvider} → ${searchProviders.fallbackSearchProvider}`,
      category.trustBlogAsSource ? "블로그 신뢰" : ""
    ].filter(Boolean).join(" · ");
    const row = document.createElement("div");
    row.className = `category-row${state.editingCategoryId === category.id ? " selected" : ""}`;
    row.dataset.categoryId = category.id;
    row.innerHTML = `
      <button type="button" class="drag-handle" draggable="true" aria-label="카테고리 순서 드래그" title="드래그해서 순서 변경">⇅</button>
      <input class="list-check" type="checkbox" ${category.checked !== false ? "checked" : ""} aria-label="자동 발행 카테고리 선택" />
      <div class="category-main">
        <strong>${escapeHtml(category.name)}</strong>
        <span>${escapeHtml(category.keyword || "검색 키워드 없음")}</span>
        ${optionSummary ? `<small>${escapeHtml(optionSummary)}</small>` : ""}
      </div>
      <div class="category-actions">
        <button type="button" class="ghost small" data-action="move-up" ${index === 0 ? "disabled" : ""}>위</button>
        <button type="button" class="ghost small" data-action="move-down" ${index === account.categories.length - 1 ? "disabled" : ""}>아래</button>
        <button type="button" class="ghost small" data-action="edit">수정</button>
        <button type="button" class="ghost small" data-action="delete">삭제</button>
      </div>
    `;
    const dragHandle = row.querySelector(".drag-handle");
    dragHandle.addEventListener("dragstart", (event) => {
      state.draggingCategoryId = category.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", category.id);
    });
    dragHandle.addEventListener("dragend", () => {
      state.draggingCategoryId = "";
      row.classList.remove("dragging");
      list.querySelectorAll(".category-row.drag-over").forEach((item) => item.classList.remove("drag-over"));
    });
    row.addEventListener("dragover", (event) => {
      if (!state.draggingCategoryId || state.draggingCategoryId === category.id) return;
      event.preventDefault();
      row.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      row.classList.remove("drag-over");
      const draggedId = state.draggingCategoryId || event.dataTransfer.getData("text/plain");
      state.draggingCategoryId = "";
      if (moveCategoryBefore(account, draggedId, category.id)) {
        await persistCategoryOrder(account);
      }
    });
    row.querySelector("input").addEventListener("change", (event) => {
      category.checked = event.target.checked;
      saveAccountStoreNow();
    });
    row.querySelector("[data-action='move-up']").addEventListener("click", async () => {
      if (moveCategoryToIndex(account, category.id, index - 1)) {
        await persistCategoryOrder(account);
      }
    });
    row.querySelector("[data-action='move-down']").addEventListener("click", async () => {
      if (moveCategoryToIndex(account, category.id, index + 1)) {
        await persistCategoryOrder(account);
      }
    });
    row.querySelector("[data-action='edit']").addEventListener("click", () => {
      editCategory(category);
    });
    row.querySelector("[data-action='delete']").addEventListener("click", () => {
      account.categories = account.categories.filter((item) => item.id !== category.id);
      if (state.editingCategoryId === category.id) {
        clearCategoryForm();
      }
      saveAccountStoreNow();
      renderCategories();
    });
    list.appendChild(row);
  }
}

function selectAccount(accountId) {
  const account = state.accountStore.accounts.find((item) => item.id === accountId);
  if (!account) return;
  state.accountStore.selectedAccountId = account.id;
  fillAccountForm(account);
  clearCategoryForm();
  renderAccounts();
  saveAccountStoreNow();
}

function fillAccountForm(account) {
  $("#accountLabel").value = account?.label || "";
  $("#naverId").value = account?.naverId || "";
  $("#blogId").value = account?.blogId || "";
  $("#naverPassword").value = account?.naverPassword || "";
  renderAccountSampleImage(account);
}

function accountImageStatusLabel(account) {
  if (!account?.sampleImagePath) return "Default image style";
  const status = account.imageStylePromptStatus || (account.imageStylePrompt ? "ready" : "missing");
  if (status === "ready") return "Custom style prompt ready";
  if (status === "stale") return "Image changed - prompt will regenerate";
  if (status === "failed") return `Prompt generation failed${account.imageStylePromptError ? `: ${account.imageStylePromptError}` : ""}`;
  return "Prompt will be generated on next run";
}

function renderAccountSampleImage(account = selectedAccount()) {
  const preview = $("#accountSampleImagePreview");
  const status = $("#accountImagePromptStatus");
  const chooseButton = $("#chooseAccountSampleImageButton");
  const deleteButton = $("#deleteAccountSampleImageButton");
  if (!preview || !status) return;
  preview.innerHTML = "";
  if (account?.sampleImageUrl) {
    const image = document.createElement("img");
    image.src = account.sampleImageUrl;
    image.alt = "Account sample image";
    preview.appendChild(image);
  } else {
    const empty = document.createElement("span");
    empty.textContent = "No sample image";
    preview.appendChild(empty);
  }
  status.textContent = accountImageStatusLabel(account);
  if (chooseButton) chooseButton.disabled = !account;
  if (deleteButton) deleteButton.disabled = !account || !account.sampleImagePath;
}

function clearAccountForm() {
  fillAccountForm(null);
}

function setCategoryButtonLabel() {
  const button = $("#addCategoryButton");
  if (button) {
    button.textContent = state.editingCategoryId ? "카테고리 수정" : "카테고리 등록";
  }
}

function fillCategoryForm(category = null) {
  $("#categoryName").value = category?.name || "";
  $("#categoryKeyword").value = category?.keyword || "";
  $("#categoryExcludedTopics").value = category?.excludedTopics || "";
  $("#categoryPublishPurpose").value = category?.publishPurpose || "";
  $("#categoryPreferredTone").value = category?.preferredTone || "";
  $("#categoryFreshnessLevel").value = category?.freshnessLevel || "auto";
  $("#categorySearchChannel").value = normalizeSearchChannel(category?.searchChannel);
  const searchProviders = categorySearchProviders(category);
  $("#categoryPrimarySearchProvider").value = searchProviders.primarySearchProvider;
  $("#categoryFallbackSearchProvider").value = searchProviders.fallbackSearchProvider;
  $("#categoryTrustBlogAsSource").checked = category?.trustBlogAsSource === true;
}

function clearCategoryForm() {
  state.editingCategoryId = "";
  fillCategoryForm(null);
  setCategoryButtonLabel();
}

function editCategory(category) {
  if (!category) return;
  state.editingCategoryId = category.id || "";
  state.categoryManagerOpen = true;
  renderCategories();
  fillCategoryForm(category);
  setCategoryButtonLabel();
  $("#categoryName")?.focus();
}

function hasCategoryName(category) {
  return Boolean(String(category?.name || "").trim());
}

function hasCategoryKeyword(category) {
  return Boolean(String(category?.keyword || "").trim());
}

function autoTargetKey(target) {
  const accountId = String(target?.account?.id || "");
  const categoryId = String(target?.category?.id || target?.category?.name || "");
  return `${accountId}::${categoryId}`;
}

function setPendingAutoTarget(target) {
  state.autoPendingSessionTarget = {
    key: autoTargetKey(target),
    accountId: String(target?.account?.id || ""),
    categoryId: String(target?.category?.id || target?.category?.name || ""),
    accountLabel: String(target?.account?.label || target?.account?.naverId || ""),
    categoryName: String(target?.category?.name || "")
  };
}

function clearPendingAutoTarget(key = "") {
  if (!key || state.autoPendingSessionTarget?.key === key) {
    state.autoPendingSessionTarget = null;
  }
}

function findAutoTargetIndex(targets, key) {
  const index = targets.findIndex((target) => autoTargetKey(target) === key);
  return index >= 0 ? index : 0;
}

function firstAutoTargetForAccount(accountId) {
  const id = String(accountId || "");
  return getAutoTargets().find((target) => String(target?.account?.id || "") === id) || null;
}

async function saveAccountStoreNow() {
  state.accountStore = await window.blogAuto.saveAccountStore(state.accountStore);
  renderAccounts();
}

function moveAccountToIndex(accountId, targetIndex) {
  const accounts = state.accountStore.accounts || [];
  const fromIndex = accounts.findIndex((account) => account.id === accountId);
  if (fromIndex < 0) return false;
  const boundedTarget = Math.max(0, Math.min(targetIndex, accounts.length - 1));
  if (fromIndex === boundedTarget) return false;
  const [account] = accounts.splice(fromIndex, 1);
  accounts.splice(boundedTarget, 0, account);
  return true;
}

function moveAccountBefore(accountId, beforeAccountId) {
  const accounts = state.accountStore.accounts || [];
  if (accountId === beforeAccountId) return false;
  const fromIndex = accounts.findIndex((account) => account.id === accountId);
  const targetIndex = accounts.findIndex((account) => account.id === beforeAccountId);
  if (fromIndex < 0 || targetIndex < 0) return false;
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  return moveAccountToIndex(accountId, adjustedTarget);
}

async function persistAccountOrder() {
  await saveAccountStoreNow();
}

function moveCategoryToIndex(account, categoryId, targetIndex) {
  if (!account || !Array.isArray(account.categories)) return false;
  const fromIndex = account.categories.findIndex((category) => category.id === categoryId);
  if (fromIndex < 0) return false;
  const boundedTarget = Math.max(0, Math.min(targetIndex, account.categories.length - 1));
  if (fromIndex === boundedTarget) return false;
  const [category] = account.categories.splice(fromIndex, 1);
  account.categories.splice(boundedTarget, 0, category);
  return true;
}

function moveCategoryBefore(account, categoryId, beforeCategoryId) {
  if (!account || categoryId === beforeCategoryId || !Array.isArray(account.categories)) return false;
  const fromIndex = account.categories.findIndex((category) => category.id === categoryId);
  const targetIndex = account.categories.findIndex((category) => category.id === beforeCategoryId);
  if (fromIndex < 0 || targetIndex < 0) return false;
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  return moveCategoryToIndex(account, categoryId, adjustedTarget);
}

async function persistCategoryOrder(account) {
  await saveAccountStoreNow();
  renderCategories();
}

function normalizeAgentModels(models = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_AGENT_MODELS).map(([agent, fallback]) => {
    const value = String(models?.[agent] || fallback);
    return [agent, VALID_AGENT_MODEL_VALUES.has(value) ? value : fallback];
  }));
}

function currentAgentModels() {
  return normalizeAgentModels(Object.fromEntries(Object.entries(AGENT_MODEL_SELECTORS).map(([agent, selector]) => (
    [agent, $(selector)?.value || DEFAULT_AGENT_MODELS[agent]]
  ))));
}

function applyAgentModels(models = {}) {
  const normalized = normalizeAgentModels(models);
  for (const [agent, selector] of Object.entries(AGENT_MODEL_SELECTORS)) {
    const control = $(selector);
    if (control) control.value = normalized[agent];
  }
}

function collectForm(target = {}) {
  const account = target.account || selectedAccount();
  const category = target.category
    || (account?.categories || []).find((item) => item.checked !== false && hasCategoryName(item) && hasCategoryKeyword(item))
    || (account?.categories || []).find((item) => item.checked !== false);
  const useSelectedAccount = Boolean(target.account || account);
  const searchProviders = categorySearchProviders(category);
  return {
    accountId: account?.id || "",
    naverId: useSelectedAccount ? (account?.naverId || "") : $("#naverId").value.trim(),
    blogId: useSelectedAccount ? (account?.blogId || account?.naverId || "") : ($("#blogId").value.trim() || $("#naverId").value.trim()),
    naverPassword: useSelectedAccount ? (account?.naverPassword || "") : $("#naverPassword").value,
    topicMode: $("#topicMode").value,
    repeatTermMinutes: Number($("#repeatTermMinutes").value || 60),
    topic: $("#topic").value.trim(),
    category: category?.name || "",
    keyword: category?.keyword || "",
    excludedTopics: category?.excludedTopics || "",
    publishPurpose: category?.publishPurpose || "",
    preferredTone: category?.preferredTone || "",
    freshnessLevel: category?.freshnessLevel || "auto",
    searchChannel: normalizeSearchChannel(category?.searchChannel),
    trustBlogAsSource: category?.trustBlogAsSource === true,
    codexCmdPath: "codex.cmd",
    primarySearchProvider: searchProviders.primarySearchProvider,
    fallbackSearchProvider: searchProviders.fallbackSearchProvider,
    naverSearchUrl: DEFAULT_NAVER_SEARCH_URL,
    googleSearchUrl: DEFAULT_GOOGLE_SEARCH_URL,
    naverEditorDomNotes: "",
    publishAfterGenerate: $("#publishAfterGenerate").checked,
    publishToTistoryAfterNaver: $("#publishToTistoryAfterNaver")?.checked === true,
    tistoryBlogId: $("#tistoryBlogId")?.value.trim() || "",
    publishVisibility: $("#publishVisibility").value,
    publishPrivate: $("#publishVisibility").value !== "public",
    publishScheduleMode: $("#publishScheduleMode").value,
    reserveAfterHours: Number($("#reserveAfterHours").value || 0),
    includeTitleImage: $("#includeTitleImage").checked,
    titleImageAspectRatio: normalizeImageAspectRatio($("#titleImageAspectRatio").value),
    bodyImageAspectRatio: normalizeImageAspectRatio($("#bodyImageAspectRatio").value),
    maxBodyImages: Number($("#maxBodyImages").value),
    breakSentencesInBody: $("#breakSentencesInBody").checked,
    agentModels: currentAgentModels(),
    excludedKeywordLanes: Array.isArray(target.excludedKeywordLanes) ? target.excludedKeywordLanes : [],
    failOnLoginRequired: target.failOnLoginRequired === true
  };
}

function applySettings(settings) {
  const map = {
    topic: "#topic",
    topicMode: "#topicMode",
    repeatTermMinutes: "#repeatTermMinutes",
    tistoryBlogId: "#tistoryBlogId",
    publishVisibility: "#publishVisibility",
    publishScheduleMode: "#publishScheduleMode",
    reserveAfterHours: "#reserveAfterHours",
    maxBodyImages: "#maxBodyImages"
  };
  for (const [key, selector] of Object.entries(map)) {
    if (settings[key] !== undefined && $(selector)) {
      $(selector).value = settings[key];
    }
  }
  $("#publishAfterGenerate").checked = settings.publishAfterGenerate === true;
  if ($("#publishToTistoryAfterNaver")) $("#publishToTistoryAfterNaver").checked = settings.publishToTistoryAfterNaver === true;
  state.tistorySessionStatus = settings.tistorySessionStatus || "unknown";
  $("#includeTitleImage").checked = settings.includeTitleImage !== false;
  $("#titleImageAspectRatio").value = normalizeImageAspectRatio(settings.titleImageAspectRatio || settings.imageAspectRatio);
  $("#bodyImageAspectRatio").value = normalizeImageAspectRatio(settings.bodyImageAspectRatio || settings.imageAspectRatio);
  $("#breakSentencesInBody").checked = settings.breakSentencesInBody !== false;
  applyAgentModels(settings.agentModels);
  if (settings.publishPrivate === false) $("#publishVisibility").value = "public";
  updateModeControls();
}

async function saveSettingsNow() {
  $("#settingsState").textContent = "설정 저장 중";
  const form = collectForm();
  await window.blogAuto.saveSettings({
    naverId: form.naverId,
    blogId: form.blogId,
    naverPassword: form.naverPassword,
    topic: form.topic,
    keyword: form.keyword,
    category: form.category,
    primarySearchProvider: form.primarySearchProvider,
    fallbackSearchProvider: form.fallbackSearchProvider,
    naverSearchUrl: form.naverSearchUrl,
    googleSearchUrl: form.googleSearchUrl,
    naverEditorDomNotes: form.naverEditorDomNotes,
    publishAfterGenerate: form.publishAfterGenerate,
    publishToTistoryAfterNaver: form.publishToTistoryAfterNaver,
    tistoryBlogId: form.tistoryBlogId,
    publishPrivate: form.publishPrivate,
    topicMode: form.topicMode,
    repeatTermMinutes: form.repeatTermMinutes,
    publishVisibility: form.publishVisibility,
    publishScheduleMode: form.publishScheduleMode,
    reserveAfterHours: form.reserveAfterHours,
    includeTitleImage: form.includeTitleImage,
    titleImageAspectRatio: form.titleImageAspectRatio,
    bodyImageAspectRatio: form.bodyImageAspectRatio,
    maxBodyImages: form.maxBodyImages,
    breakSentencesInBody: form.breakSentencesInBody,
    agentModels: form.agentModels
  });
  await saveAccountStoreNow();
  $("#settingsState").textContent = "설정 저장됨";
}

function scheduleSettingsSave() {
  window.clearTimeout(state.saveTimer);
  $("#settingsState").textContent = "변경 감지";
  state.saveTimer = window.setTimeout(() => {
    saveSettingsNow().catch((error) => {
      $("#settingsState").textContent = "설정 저장 실패";
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    });
  }, 450);
}

function updateModeControls() {
  const isAuto = $("#topicMode").value === "auto";
  const isPrivatePublish = $("#publishVisibility").value !== "public";
  $("#repeatTermLabel").style.display = isAuto ? "grid" : "none";
  $("#manualTopicLabel").style.display = isAuto ? "none" : "grid";
  $("#publishAfterGenerate").checked = isAuto ? true : $("#publishAfterGenerate").checked;
  $("#publishAfterGenerate").disabled = isAuto;
  if (isPrivatePublish && $("#publishScheduleMode").value === "reserve") {
    $("#publishScheduleMode").value = "now";
  }
  $("#publishScheduleMode").disabled = isPrivatePublish;
  $("#reserveAfterLabel").style.display = !isPrivatePublish && $("#publishScheduleMode").value === "reserve" ? "grid" : "none";
}

function getAutoTargets() {
  const targets = [];
  for (const account of state.accountStore.accounts.filter((item) => item.checked !== false)) {
    for (const category of (account.categories || []).filter((item) => item.checked !== false && hasCategoryName(item) && hasCategoryKeyword(item))) {
      targets.push({ account, category });
    }
  }
  return targets;
}

function allNaverSessionsExpired(targets) {
  return Boolean(targets.length) && targets.every((target) => target.account?.sessionStatus === "expired");
}

function nextDifferentAccountIndex(targets, index) {
  if (!targets.length) return 0;
  const currentAccountId = targets[index % targets.length]?.account?.id || "";
  for (let offset = 1; offset <= targets.length; offset += 1) {
    const nextIndex = (index + offset) % targets.length;
    if ((targets[nextIndex]?.account?.id || "") !== currentAccountId) {
      return nextIndex;
    }
  }
  return index;
}

function delayAuto(minutes) {
  const ms = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (state.autoDelayWake === finish) state.autoDelayWake = null;
      resolve();
    };
    const started = Date.now();
    state.autoDelayWake = finish;
    const tick = () => {
      if (!state.autoRunning) {
        finish();
        return;
      }
      const remaining = Math.max(0, ms - (Date.now() - started));
      setRunState("generated", `다음 발행까지 ${Math.ceil(remaining / 1000)}초`);
      if (remaining <= 0) finish();
      else window.setTimeout(tick, Math.min(1000, remaining));
    };
    tick();
  });
}

function waitForAccountSessionOrTerm(accountId, minutes) {
  const waitingAccountId = String(accountId || "");
  const ms = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Promise((resolve) => {
    if (state.autoResumeAccountId === waitingAccountId) {
      state.autoResumeAccountId = "";
      resolve("session");
      return;
    }
    let settled = false;
    const started = Date.now();
    const wake = () => {
      if (state.autoResumeAccountId === waitingAccountId) {
        finish("session");
      }
    };
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (state.autoDelayWake === wake) state.autoDelayWake = null;
      if (reason === "session") state.autoResumeAccountId = "";
      resolve(reason);
    };
    state.autoDelayWake = wake;
    const tick = () => {
      if (!state.autoRunning) {
        finish("stopped");
        return;
      }
      if (state.autoResumeAccountId === waitingAccountId) {
        finish("session");
        return;
      }
      const remaining = Math.max(0, ms - (Date.now() - started));
      setRunState("session_expired", `세션 확인 대기 중 ${Math.ceil(remaining / 1000)}초`);
      if (remaining <= 0) {
        finish("term");
        return;
      }
      window.setTimeout(tick, Math.min(1000, remaining));
    };
    tick();
  });
}

async function startAutoPublishing(startTargetKey = "") {
  const checkedTargets = state.accountStore.accounts
    .filter((account) => account.checked !== false)
    .flatMap((account) => (account.categories || [])
      .filter((category) => category.checked !== false)
      .map((category) => ({ account, category })));
  if (!checkedTargets.length) {
    throw new Error("자동 발행할 체크된 계정/카테고리 조합이 없습니다.");
  }
  const checkedTargetsWithKeyword = checkedTargets.filter((target) => (
    hasCategoryName(target.category) && hasCategoryKeyword(target.category)
  ));
  if (!checkedTargetsWithKeyword.length) {
    throw new Error("자동 발행하려면 체크된 카테고리의 카테고리명과 키워드를 먼저 등록하세요.");
  }
  if (allNaverSessionsExpired(checkedTargetsWithKeyword)) {
    throw new Error("All selected Naver sessions are expired. Check at least one Naver session before starting auto publishing.");
  }
  const startupForm = collectForm();
  if (startupForm.publishToTistoryAfterNaver && !startupForm.tistoryBlogId) throw new Error("Tistory blog ID is required.");
  state.running = true;
  state.autoRunning = true;
  state.autoPausedForSession = false;
  $("#startButton").disabled = true;
  setTistoryTestButtonDisabled(true);
  $("#stopAutoButton").disabled = false;
  await saveSettingsNow();
  setTokenTotal(0);

  let index = startTargetKey ? findAutoTargetIndex(getAutoTargets(), startTargetKey) : 0;
  autoLoop:
  while (state.autoRunning) {
    const targets = getAutoTargets();
    if (!targets.length) {
      addLog({
        level: "warn",
        message: "체크된 계정 중 자동 발행 가능한 대상이 없습니다.",
        at: new Date().toISOString()
      });
      await delayAuto(Number($("#repeatTermMinutes").value || 60));
      continue;
    }
    if (allNaverSessionsExpired(targets)) {
      addLog({
        level: "warn",
        message: "All selected Naver sessions are expired. Auto publishing stopped.",
        at: new Date().toISOString()
      });
      state.autoRunning = false;
      break;
    }
    index %= targets.length;
    const target = targets[index];
    if (target.account.sessionStatus === "expired") {
      setPendingAutoTarget(target);
      addLog({
        level: "warn",
        message: `${target.account.label || target.account.naverId} 계정은 세션만료 상태입니다. ${target.category.name} 작업은 세션확인 또는 반복주기까지 대기합니다.`,
        at: new Date().toISOString()
      });
      state.autoPausedForSession = true;
      state.autoWaitingSessionAccountId = target.account.id || "";
      const waitResult = await waitForAccountSessionOrTerm(target.account.id, Number($("#repeatTermMinutes").value || 60));
      state.autoPausedForSession = false;
      state.autoWaitingSessionAccountId = "";
      if (waitResult === "session") {
        clearPendingAutoTarget(autoTargetKey(target));
        addLog({
          level: "info",
          message: `${target.account.label || target.account.naverId} 계정 세션확인이 완료되어 ${target.category.name} 작업을 즉시 재시도합니다.`,
          at: new Date().toISOString()
        });
        continue;
      }
      if (waitResult === "term") {
        clearPendingAutoTarget(autoTargetKey(target));
        index = nextDifferentAccountIndex(targets, index);
        continue;
      }
      break;
    }
    clearPendingAutoTarget(autoTargetKey(target));
    let autoAttemptLimit = AUTO_TARGET_MAX_ATTEMPTS;
    const excludedKeywordLanes = new Set();
    for (let attempt = 1; attempt <= autoAttemptLimit && state.autoRunning; attempt += 1) {
      addLog({
        level: "info",
        message: `자동 Cycle 시작 (${attempt}/${autoAttemptLimit}): ${target.account.label || target.account.naverId} / ${target.category.name}`,
        at: new Date().toISOString()
      });
      $("#selectedTitle").textContent = "아직 선정 전";
      $("#articlePreview").value = "";
      renderImages([]);
      renderImageNotes([]);
      const result = await runAutoStartJob(collectForm({
        account: target.account,
        category: target.category,
        excludedKeywordLanes: [...excludedKeywordLanes],
        failOnLoginRequired: true
      }));
      if (result?.status === "codex_usage_limit") {
        addLog({
          level: "error",
          message: "Codex 사용량 한도 초과로 자동 작업을 중지합니다.",
          at: new Date().toISOString()
        });
        state.autoRunning = false;
        break autoLoop;
      }
      if (result?.status === "session_expired") {
        target.account.sessionStatus = "expired";
        if (allNaverSessionsExpired(getAutoTargets())) {
          renderAccounts();
          addLog({
            level: "warn",
            message: "All selected Naver sessions are expired. Auto publishing stopped.",
            at: new Date().toISOString()
          });
          state.autoRunning = false;
          break autoLoop;
        }
        setPendingAutoTarget(target);
        renderAccounts();
        addLog({
          level: "warn",
          message: `${target.account.label || target.account.naverId} 계정은 세션만료 상태입니다. ${target.category.name} 작업은 세션확인 또는 반복주기까지 대기합니다.`,
          at: new Date().toISOString()
        });
        state.autoPausedForSession = true;
        state.autoWaitingSessionAccountId = target.account.id || "";
        const waitResult = await waitForAccountSessionOrTerm(target.account.id, Number($("#repeatTermMinutes").value || 60));
        state.autoPausedForSession = false;
        state.autoWaitingSessionAccountId = "";
        if (waitResult === "session") {
          clearPendingAutoTarget(autoTargetKey(target));
          addLog({
            level: "info",
            message: `${target.account.label || target.account.naverId} 계정 세션확인이 완료되어 ${target.category.name} 작업을 즉시 재시도합니다.`,
            at: new Date().toISOString()
          });
          continue autoLoop;
        }
        if (waitResult === "term") {
          clearPendingAutoTarget(autoTargetKey(target));
          index = nextDifferentAccountIndex(targets, index);
          continue autoLoop;
        }
        break autoLoop;
      }
      if (!shouldRetryAutoResult(result)) {
        break;
      }
      const failedLanes = keywordLanePhrasesFromResult(result);
      for (const lane of failedLanes) excludedKeywordLanes.add(lane);
      autoAttemptLimit = Math.min(autoAttemptLimit, autoAttemptLimitForResult(result));
      if (attempt < autoAttemptLimit) {
        addLog({
          level: "warn",
          message: `자동 Cycle 실패, 같은 대상으로 재시도합니다 (${attempt + 1}/${autoAttemptLimit}): ${autoResultReason(result)}${failedLanes.length ? ` / 제외 lane: ${failedLanes.join(", ")}` : ""}`,
          at: new Date().toISOString()
        });
        continue;
      }
      addLog({
        level: "warn",
        message: `자동 Cycle ${autoAttemptLimit}회 실패로 다음 대상으로 이동합니다: ${autoResultReason(result)}`,
        at: new Date().toISOString()
      });
    }
    index += 1;
    if (state.autoRunning) {
      await delayAuto(Number($("#repeatTermMinutes").value || 60));
    }
  }

  state.autoRunning = false;
  state.autoPausedForSession = false;
  state.autoWaitingSessionAccountId = "";
  state.autoResumeAccountId = "";
  state.autoPendingSessionTarget = null;
  state.running = false;
  $("#startButton").disabled = false;
  setTistoryTestButtonDisabled(false);
  $("#stopAutoButton").disabled = true;
  setRunState("generated", "자동 중지");
}

async function startManualJob() {
  const form = collectForm();
  if (form.publishAfterGenerate && form.publishToTistoryAfterNaver && !form.tistoryBlogId) throw new Error("Tistory blog ID is required.");
  if (!form.topic) throw new Error("수동 방식에서는 주제가 필요합니다.");
  if (!form.category) throw new Error("선택 계정에서 카테고리를 체크하세요.");
  if (!form.keyword) throw new Error("선택한 카테고리에 검색 키워드를 등록하세요.");
  if (form.publishAfterGenerate && !form.naverId) throw new Error("발행까지 진행하려면 작업할 계정을 선택하거나 등록하세요.");
  state.running = true;
  $("#startButton").disabled = true;
  setTistoryTestButtonDisabled(true);
  await saveSettingsNow();
  setTokenTotal(0);
  $("#articlePreview").value = "";
  $("#selectedTitle").textContent = "아직 선정 전";
  renderImages([]);
  renderImageNotes([]);
  setRunState("generating", "생성 준비");
  try {
    await window.blogAuto.startJob(form);
  } finally {
    if (!state.autoRunning) {
      state.running = false;
      $("#startButton").disabled = false;
      setTistoryTestButtonDisabled(false);
    }
  }
}

async function startTistoryTestPublish() {
  const form = collectForm();
  if (!form.tistoryBlogId) throw new Error("Tistory blog ID is required.");
  state.running = true;
  $("#startButton").disabled = true;
  setTistoryTestButtonDisabled(true);
  await saveSettingsNow();
  setTokenTotal(0);
  $("#articlePreview").value = "";
  $("#selectedTitle").textContent = "Tistory test";
  renderImages([]);
  renderImageNotes([]);
  setRunState("publishing", "Tistory test");
  try {
    const result = await window.blogAuto.testTistoryPublish({
      ...form,
      failOnLoginRequired: false
    });
    $("#articlePreview").value = result.article || $("#articlePreview").value;
    $("#articleMeta").textContent = result.title || "Tistory test complete";
    if (result.title) $("#selectedTitle").textContent = result.title;
    renderImages(result.images || []);
    renderImageNotes(result.imageNotes || []);
  } finally {
    if (!state.autoRunning) {
      state.running = false;
      $("#startButton").disabled = false;
      setTistoryTestButtonDisabled(false);
    }
  }
}

async function boot() {
  const initial = await window.blogAuto.getInitialData();
  $("#runtimePath").textContent = initial.runtimeRoot;
  state.chrome = initial.chrome || state.chrome;
  state.accountStore = initial.accountStore || state.accountStore;
  applySettings(initial.settings || {});
  setCodexRateLimits(initial.settings?.codexRateLimits || null);
  refreshCodexUsageOnStartup();
  showStartupNoticeIfNeeded();
  renderAccounts();
  const account = selectedAccount();
  if (account) selectAccount(account.id);
  renderHistory(initial.history || []);

  window.blogAuto.onAccountsUpdate((store) => {
    state.accountStore = store;
    renderAccounts();
    fillAccountForm(selectedAccount());
  });
  window.blogAuto.onLog(addLog);
  window.blogAuto.onStatus((payload) => {
    state.currentJobId = payload.jobId;
    setRunState(payload.status, payload.detail || payload.status);
  });
  window.blogAuto.onTokens((payload) => {
    setTokenTotal(payload.total || 0);
    if (payload.rateLimits) setCodexRateLimits(payload.rateLimits);
  });
  window.blogAuto.onPreview((payload) => {
    $("#articlePreview").value = payload.article || "";
    $("#articleMeta").textContent = payload.title || "본문 생성 완료";
    if (payload.title) $("#selectedTitle").textContent = payload.title;
    if (payload.tokenUsage) setTokenTotal(payload.tokenUsage.total || 0);
    if (payload.tokenUsage?.rateLimits) setCodexRateLimits(payload.tokenUsage.rateLimits);
    renderImages(payload.images || []);
    renderImageNotes(payload.imageNotes || []);
  });
  window.blogAuto.onSelectedTitle((payload) => {
    $("#selectedTitle").textContent = payload.title || "제목 선정 보류";
    $("#articleMeta").textContent = payload.verdict || payload.status || "제목 선정 완료";
  });
  window.blogAuto.onComplete((payload) => {
    if (!state.autoRunning) {
      state.running = false;
      $("#startButton").disabled = false;
      setTistoryTestButtonDisabled(false);
    }
    setRunState(payload.status, payload.status);
    $("#articlePreview").value = payload.article || $("#articlePreview").value;
    $("#articleMeta").textContent = payload.title || payload.status || "완료";
    if (payload.title) $("#selectedTitle").textContent = payload.title;
    if (payload.tokenUsage) setTokenTotal(payload.tokenUsage.total || 0);
    if (payload.tokenUsage?.rateLimits) setCodexRateLimits(payload.tokenUsage.rateLimits);
    renderImages(payload.images || []);
    renderImageNotes(payload.imageNotes || []);
    renderHistory(payload.history || []);
  });

  $("#jobForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.running) return;
    try {
      if ($("#topicMode").value === "auto") {
        await startAutoPublishing();
      } else {
        await startManualJob();
      }
    } catch (error) {
      state.running = false;
      state.autoRunning = false;
      state.autoPausedForSession = false;
      state.autoWaitingSessionAccountId = "";
      state.autoResumeAccountId = "";
      state.autoPendingSessionTarget = null;
      $("#startButton").disabled = false;
      $("#stopAutoButton").disabled = true;
      setRunState("failed", "실패");
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    }
  });

  $("#tistoryTestButton")?.addEventListener("click", async () => {
    if (state.running || state.autoRunning) return;
    try {
      await startTistoryTestPublish();
    } catch (error) {
      state.running = false;
      state.autoRunning = false;
      $("#startButton").disabled = false;
      setTistoryTestButtonDisabled(false);
      $("#stopAutoButton").disabled = true;
      setRunState("failed", "Tistory test failed");
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    }
  });

  $("#addAccountButton").addEventListener("click", async () => {
    const naverId = $("#naverId").value.trim();
    if (!naverId) {
      addLog({ level: "error", message: "Naver ID를 입력하세요.", at: new Date().toISOString() });
      return;
    }
    const duplicate = state.accountStore.accounts.find((account) => account.naverId === naverId);
    if (duplicate) {
      addLog({ level: "error", message: "이미 등록된 Naver ID입니다. 기존 계정을 선택한 뒤 수정하세요.", at: new Date().toISOString() });
      return;
    }
    const account = {
      id: makeId("acct"),
      label: $("#accountLabel").value.trim() || naverId,
      naverId,
      blogId: $("#blogId").value.trim(),
      naverPassword: $("#naverPassword").value,
      sampleImagePath: "",
      sampleImageHash: "",
      sampleImageUpdatedAt: "",
      imageStylePrompt: "",
      imageStylePromptUpdatedAt: "",
      imageStylePromptStatus: "missing",
      imageStylePromptSourceImageHash: "",
      imageStylePromptError: "",
      checked: true,
      sessionStatus: "unknown",
      sessionCheckedAt: "",
      categories: []
    };
    state.accountStore.accounts.push(account);
    state.accountStore.selectedAccountId = account.id;
    await saveAccountStoreNow();
  });

  $("#updateAccountButton").addEventListener("click", async () => {
    const account = selectedAccount();
    if (!account) {
      addLog({ level: "error", message: "수정할 계정을 먼저 선택하세요.", at: new Date().toISOString() });
      return;
    }
    const naverId = $("#naverId").value.trim();
    if (!naverId) {
      addLog({ level: "error", message: "Naver ID를 입력하세요.", at: new Date().toISOString() });
      return;
    }
    const duplicate = state.accountStore.accounts.find((item) => item.id !== account.id && item.naverId === naverId);
    if (duplicate) {
      addLog({ level: "error", message: "다른 계정에 이미 등록된 Naver ID입니다.", at: new Date().toISOString() });
      return;
    }
    account.label = $("#accountLabel").value.trim() || naverId;
    account.naverId = naverId;
    account.blogId = $("#blogId").value.trim();
    account.naverPassword = $("#naverPassword").value;
    await saveAccountStoreNow();
  });

  $("#clearAccountFormButton").addEventListener("click", () => {
    clearAccountForm();
    addLog({ level: "info", message: "신규 계정 입력을 시작합니다.", at: new Date().toISOString() });
  });

  $("#chooseAccountSampleImageButton").addEventListener("click", async () => {
    const account = selectedAccount();
    if (!account) {
      addLog({ level: "error", message: "Select an account before adding a sample image.", at: new Date().toISOString() });
      return;
    }
    state.accountStore = await window.blogAuto.chooseAccountSampleImage(account.id);
    renderAccounts();
    fillAccountForm(selectedAccount());
    scheduleSettingsSave();
  });

  $("#deleteAccountSampleImageButton").addEventListener("click", async () => {
    const account = selectedAccount();
    if (!account || !account.sampleImagePath) return;
    if (!window.confirm("Delete the sample image and custom image prompt?")) return;
    state.accountStore = await window.blogAuto.deleteAccountSampleImage(account.id);
    renderAccounts();
    fillAccountForm(selectedAccount());
    scheduleSettingsSave();
  });

  $("#toggleAccountManagerButton").addEventListener("click", () => {
    state.accountManagerOpen = !state.accountManagerOpen;
    if (state.accountManagerOpen) {
      fillAccountForm(selectedAccount());
    }
    renderAccounts();
  });

  const legacyCheckSessionButton = $("#checkSessionButton");
  if (legacyCheckSessionButton) {
    legacyCheckSessionButton.addEventListener("click", () => checkAccountSession(selectedAccount()));
  }
  $("#bulkSessionCheckButton").addEventListener("click", checkSelectedAccountSessions);

  $("#toggleCategoryManagerButton").addEventListener("click", () => {
    clearCategoryForm();
    state.categoryManagerOpen = !state.categoryManagerOpen;
    renderCategories();
  });
  $("#categoryPrimarySearchProvider").addEventListener("change", () => {
    const primary = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
    const fallback = normalizeSearchProvider($("#categoryFallbackSearchProvider").value, fallbackSearchProviderFor(primary));
    if (fallback === primary) {
      $("#categoryFallbackSearchProvider").value = fallbackSearchProviderFor(primary);
    }
  });
  $("#categoryFallbackSearchProvider").addEventListener("change", () => {
    const primary = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
    const fallback = normalizeSearchProvider($("#categoryFallbackSearchProvider").value, fallbackSearchProviderFor(primary));
    if (fallback === primary) {
      $("#categoryPrimarySearchProvider").value = fallbackSearchProviderFor(fallback);
    }
  });
  $("#addCategoryButton").addEventListener("click", async () => {
    const account = selectedAccount();
    const name = $("#categoryName").value.trim();
    const keyword = $("#categoryKeyword").value.trim();
    const excludedTopics = $("#categoryExcludedTopics").value.trim();
    const publishPurpose = $("#categoryPublishPurpose").value.trim();
    const preferredTone = $("#categoryPreferredTone").value.trim();
    const freshnessLevel = $("#categoryFreshnessLevel").value || "auto";
    const searchChannel = normalizeSearchChannel($("#categorySearchChannel").value);
    const primarySearchProvider = normalizeSearchProvider($("#categoryPrimarySearchProvider").value, "naver");
    let fallbackSearchProvider = normalizeSearchProvider(
      $("#categoryFallbackSearchProvider").value,
      fallbackSearchProviderFor(primarySearchProvider)
    );
    if (fallbackSearchProvider === primarySearchProvider) {
      fallbackSearchProvider = fallbackSearchProviderFor(primarySearchProvider);
      $("#categoryFallbackSearchProvider").value = fallbackSearchProvider;
    }
    const trustBlogAsSource = $("#categoryTrustBlogAsSource").checked === true;
    if (!account) return;
    if (!name || !keyword) {
      addLog({
        level: "warn",
        message: "카테고리를 등록하려면 카테고리명과 검색 키워드를 모두 입력하세요.",
        at: new Date().toISOString()
      });
      setRunState("failed", "카테고리명/키워드 필요");
      return;
    }
    account.categories = account.categories || [];
    const editingId = state.editingCategoryId;
    const existing = editingId
      ? account.categories.find((category) => category.id === editingId)
      : null;
    if (editingId && existing) {
      existing.keyword = keyword;
      existing.name = name;
      existing.excludedTopics = excludedTopics;
      existing.publishPurpose = publishPurpose;
      existing.preferredTone = preferredTone;
      existing.freshnessLevel = freshnessLevel;
      existing.searchChannel = searchChannel;
      existing.primarySearchProvider = primarySearchProvider;
      existing.fallbackSearchProvider = fallbackSearchProvider;
      existing.trustBlogAsSource = trustBlogAsSource;
      existing.checked = true;
    } else if (account.categories.some((category) => category.name === name)) {
      addLog({
        level: "warn",
        message: "같은 이름의 카테고리가 이미 있습니다. 기존 카테고리를 수정하려면 목록의 수정 버튼을 눌러 주세요.",
        at: new Date().toISOString()
      });
      setRunState("failed", "중복 카테고리명");
      return;
    } else {
      account.categories.push({
        id: makeId("cat"),
        name,
        keyword,
        excludedTopics,
        publishPurpose,
        preferredTone,
        freshnessLevel,
        searchChannel,
        primarySearchProvider,
        fallbackSearchProvider,
        trustBlogAsSource,
        checked: true
      });
    }
    clearCategoryForm();
    await saveAccountStoreNow();
  });

  $("#stopAutoButton").addEventListener("click", () => {
    state.autoRunning = false;
    state.autoPausedForSession = false;
    state.autoWaitingSessionAccountId = "";
    state.autoResumeAccountId = "";
    state.autoPendingSessionTarget = null;
    $("#stopAutoButton").disabled = true;
    setRunState("generated", "자동 중지 요청");
  });
  $("#reloadHistoryButton").addEventListener("click", async () => {
    renderHistory(await window.blogAuto.loadHistory());
  });
  $("#openHistoryModalButton").addEventListener("click", async () => {
    state.historyModalOpen = true;
    renderHistory(await window.blogAuto.loadHistory());
  });
  $("#reloadHistoryModalButton").addEventListener("click", async () => {
    renderHistory(await window.blogAuto.loadHistory());
  });
  $("#closeHistoryModalButton").addEventListener("click", closeHistoryModal);
  $("#historyModal").addEventListener("click", (event) => {
    if (event.target?.id === "historyModal") closeHistoryModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.historyModalOpen) closeHistoryModal();
  });
  $("#clearLogButton").addEventListener("click", () => {
    clearAgentLogs();
  });
  $("#openRuntimeButton").addEventListener("click", () => {
    window.blogAuto.openRuntimeFolder();
  });
  $("#dismissSessionNoticeButton").addEventListener("click", () => {
    $("#sessionNotice").hidden = true;
  });
  $("#dismissStartupNoticeButton").addEventListener("click", dismissStartupNotice);
  $("#saveSettingsButton").addEventListener("click", () => {
    saveSettingsNow().catch((error) => {
      $("#settingsState").textContent = "설정 저장 실패";
      addLog({ level: "error", message: error.message, at: new Date().toISOString() });
    });
  });
  for (const selector of Object.values(AGENT_MODEL_SELECTORS)) {
    const control = $(selector);
    if (!control) continue;
    control.addEventListener("change", () => {
      saveSettingsNow().catch((error) => {
        $("#settingsState").textContent = "설정 저장 실패";
        addLog({ level: "error", message: error.message, at: new Date().toISOString() });
      });
    });
  }
  for (const selector of ["#titleImageAspectRatio", "#bodyImageAspectRatio"]) {
    $(selector).addEventListener("change", () => {
      saveSettingsNow().catch((error) => {
        $("#settingsState").textContent = "설정 저장 실패";
        addLog({ level: "error", message: error.message, at: new Date().toISOString() });
      });
    });
  }
  $("#topicMode").addEventListener("change", updateModeControls);
  $("#publishVisibility").addEventListener("change", updateModeControls);
  $("#publishScheduleMode").addEventListener("change", updateModeControls);
  $("#jobForm").querySelectorAll("input, select, textarea").forEach((control) => {
    if ([
      "accountLabel",
      "naverId",
      "blogId",
      "naverPassword",
      "categoryName",
      "categoryKeyword",
      "categoryExcludedTopics",
      "categoryPublishPurpose",
      "categoryPreferredTone",
      "categoryFreshnessLevel",
      "categorySearchChannel",
      "categoryPrimarySearchProvider",
      "categoryFallbackSearchProvider",
      "categoryTrustBlogAsSource"
    ].includes(control.id)) {
      return;
    }
    control.addEventListener("input", scheduleSettingsSave);
    control.addEventListener("change", scheduleSettingsSave);
  });
}

boot().catch((error) => {
  addLog({ level: "error", message: error.message, at: new Date().toISOString() });
});
