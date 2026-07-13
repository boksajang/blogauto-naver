const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const targets = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      targets.push(full);
    }
  }
}

walk(path.join(root, "src"));
walk(path.join(root, "scripts"));

let failed = false;
for (const file of targets) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}

if (failed) {
  process.exit(1);
}

function assertIncludes(file, text, description) {
  if (!file.content.includes(text)) {
    failed = true;
    console.error(`${file.relative}: missing ${description}`);
  }
}

function assertNotIncludes(file, text, description) {
  if (file.content.includes(text)) {
    failed = true;
    console.error(`${file.relative}: unexpected ${description}`);
  }
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractBlockAfter(file, marker, description) {
  const markerIndex = file.content.indexOf(marker);
  if (markerIndex === -1) {
    failed = true;
    console.error(`${file.relative}: missing ${description}`);
    return null;
  }
  const openIndex = file.content.indexOf("{", markerIndex);
  const closeIndex = openIndex === -1 ? -1 : findMatchingBrace(file.content, openIndex);
  if (openIndex === -1 || closeIndex === -1) {
    failed = true;
    console.error(`${file.relative}: cannot parse ${description}`);
    return null;
  }
  return {
    start: openIndex,
    end: closeIndex,
    content: file.content.slice(openIndex, closeIndex + 1)
  };
}

function extractFunctionBlock(file, marker, description) {
  const markerIndex = file.content.indexOf(marker);
  if (markerIndex === -1) {
    failed = true;
    console.error(`${file.relative}: missing ${description}`);
    return null;
  }
  const bodyStartMarker = file.content.indexOf(") {", markerIndex);
  const openIndex = bodyStartMarker === -1 ? -1 : file.content.indexOf("{", bodyStartMarker);
  const closeIndex = openIndex === -1 ? -1 : findMatchingBrace(file.content, openIndex);
  if (openIndex === -1 || closeIndex === -1) {
    failed = true;
    console.error(`${file.relative}: cannot parse ${description}`);
    return null;
  }
  return {
    start: openIndex,
    end: closeIndex,
    content: file.content.slice(openIndex, closeIndex + 1)
  };
}

function allIndexesOf(text, needle) {
  const indexes = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    indexes.push(index);
    index = text.indexOf(needle, index + needle.length);
  }
  return indexes;
}

const sourceFiles = {
  main: {
    relative: "src/main.js",
    content: fs.readFileSync(path.join(root, "src", "main.js"), "utf8")
  },
  codexRunner: {
    relative: "src/lib/codexRunner.js",
    content: fs.readFileSync(path.join(root, "src", "lib", "codexRunner.js"), "utf8")
  },
  naverPublisher: {
    relative: "src/lib/naverPublisher.js",
    content: fs.readFileSync(path.join(root, "src", "lib", "naverPublisher.js"), "utf8")
  },
  tistoryPublisher: {
    relative: "src/lib/tistoryPublisher.js",
    content: fs.readFileSync(path.join(root, "src", "lib", "tistoryPublisher.js"), "utf8")
  },
  accountStore: {
    relative: "src/lib/accountStore.js",
    content: fs.readFileSync(path.join(root, "src", "lib", "accountStore.js"), "utf8")
  },
  imageAssets: {
    relative: "src/lib/imageAssets.js",
    content: fs.readFileSync(path.join(root, "src", "lib", "imageAssets.js"), "utf8")
  },
  rendererIndex: {
    relative: "src/renderer/index.html",
    content: fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8")
  },
  rendererApp: {
    relative: "src/renderer/app.js",
    content: fs.readFileSync(path.join(root, "src", "renderer", "app.js"), "utf8")
  },
  rendererStyles: {
    relative: "src/renderer/styles.css",
    content: fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8")
  },
  preload: {
    relative: "src/preload.js",
    content: fs.readFileSync(path.join(root, "src", "preload.js"), "utf8")
  },
  settings: {
    relative: "src/lib/settings.js",
    content: fs.readFileSync(path.join(root, "src", "lib", "settings.js"), "utf8")
  },
  search: {
    relative: "src/lib/search.js",
    content: fs.readFileSync(path.join(root, "src", "lib", "search.js"), "utf8")
  }
};

const searchLib = require(path.join(root, "src", "lib", "search.js"));
const searchPrivate = searchLib._private || {};
const codexRunnerLib = require(path.join(root, "src", "lib", "codexRunner.js"));
const codexRunnerPrivate = codexRunnerLib._private || {};
const naverPublisherLib = require(path.join(root, "src", "lib", "naverPublisher.js"));
const naverPublisherPrivate = naverPublisherLib._private || {};

function assertCondition(condition, description) {
  if (!condition) {
    failed = true;
    console.error(description);
  }
}

assertCondition(
  sourceFiles.tistoryPublisher.content.includes("const TISTORY_TAG_LIMIT = 8")
    && sourceFiles.tistoryPublisher.content.includes(".slice(0, TISTORY_TAG_LIMIT)")
    && sourceFiles.tistoryPublisher.content.includes("timeout: 5000")
    && sourceFiles.tistoryPublisher.content.includes("await inputTistoryTags(page, options.tags || [], log)")
    && sourceFiles.tistoryPublisher.content.includes("findVisibleLocator(page, \"#publish-layer-btn\", 15000)"),
  "src/lib/tistoryPublisher.js: Tistory tags must be capped and must finish before clicking the publish layer button"
);
assertCondition(
  sourceFiles.tistoryPublisher.content.includes("function splitKoreanSentences")
    && sourceFiles.tistoryPublisher.content.includes("function paragraphHtml(text, breakSentences = true)")
    && sourceFiles.tistoryPublisher.content.includes("paragraphHtml(block.text, options.breakSentencesInBody !== false)"),
  "src/lib/tistoryPublisher.js: Tistory HTML body insertion must still apply sentence line breaks when enabled"
);

const naverBlogSearchTemplate = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={query}";
const naverNewsSearchTemplate = "https://search.naver.com/search.naver?ssc=tab.news.all&where=news&sm=tab_jum&query={query}";
const naverBlogSearchFallback = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query=${query}";
assertCondition(
  sourceFiles.settings.content.includes(`DEFAULT_NAVER_SEARCH_URL = "${naverBlogSearchTemplate}"`)
    && sourceFiles.settings.content.includes("LEGACY_NAVER_SEARCH_URL")
    && sourceFiles.settings.content.includes("normalized.naverSearchUrl = DEFAULT_NAVER_SEARCH_URL"),
  "src/lib/settings.js: Naver default search URL must use the blog tab and migrate the legacy web default"
);
assertCondition(
  sourceFiles.rendererApp.content.includes(`DEFAULT_NAVER_SEARCH_URL = "${naverBlogSearchTemplate}"`),
  "src/renderer/app.js: renderer default Naver search URL must use the blog tab"
);
assertCondition(
  sourceFiles.settings.content.includes("titleImageAspectRatio: DEFAULT_IMAGE_ASPECT_RATIO")
    && sourceFiles.settings.content.includes("bodyImageAspectRatio: DEFAULT_IMAGE_ASPECT_RATIO")
    && sourceFiles.settings.content.includes("function normalizeImageAspectRatio")
    && sourceFiles.settings.content.includes("hasOwnProperty.call(parsed, \"titleImageAspectRatio\")")
    && sourceFiles.settings.content.includes("hasOwnProperty.call(parsed, \"bodyImageAspectRatio\")")
    && sourceFiles.settings.content.includes("normalized.titleImageAspectRatio = normalizeImageAspectRatio(normalized.titleImageAspectRatio || normalized.imageAspectRatio)")
    && sourceFiles.settings.content.includes("normalized.bodyImageAspectRatio = normalizeImageAspectRatio(normalized.bodyImageAspectRatio || normalized.imageAspectRatio)"),
  "src/lib/settings.js: title/body image aspect ratios must default to 16:9 and be normalized with legacy fallback"
);
assertCondition(
  sourceFiles.rendererIndex.content.includes("id=\"titleImageAspectRatio\"")
    && sourceFiles.rendererIndex.content.includes("id=\"bodyImageAspectRatio\"")
    && sourceFiles.rendererIndex.content.includes("value=\"16:9\"")
    && sourceFiles.rendererIndex.content.includes("value=\"9:16\"")
    && sourceFiles.rendererIndex.content.includes("value=\"1:1\""),
  "src/renderer/index.html: title/body image preview controls must expose 16:9, 9:16, and 1:1 aspect ratio options"
);
assertCondition(
  sourceFiles.rendererApp.content.includes("titleImageAspectRatio: normalizeImageAspectRatio($(\"#titleImageAspectRatio\").value)")
    && sourceFiles.rendererApp.content.includes("bodyImageAspectRatio: normalizeImageAspectRatio($(\"#bodyImageAspectRatio\").value)")
    && sourceFiles.rendererApp.content.includes("titleImageAspectRatio: form.titleImageAspectRatio")
    && sourceFiles.rendererApp.content.includes("bodyImageAspectRatio: form.bodyImageAspectRatio")
    && sourceFiles.rendererApp.content.includes("[\"#titleImageAspectRatio\", \"#bodyImageAspectRatio\"]"),
  "src/renderer/app.js: title/body image aspect ratios must be collected, saved, and persisted immediately on change"
);
assertCondition(
  sourceFiles.main.content.includes("const titleImageAspectRatio = normalizeImageAspectRatio(form.titleImageAspectRatio || settings.titleImageAspectRatio || form.imageAspectRatio || settings.imageAspectRatio)")
    && sourceFiles.main.content.includes("const bodyImageAspectRatio = normalizeImageAspectRatio(form.bodyImageAspectRatio || settings.bodyImageAspectRatio || form.imageAspectRatio || settings.imageAspectRatio)")
    && sourceFiles.main.content.includes("titleImageAspectRatio,")
    && sourceFiles.main.content.includes("bodyImageAspectRatio,"),
  "src/main.js: title/body image aspect ratios must flow from the form into saved settings and generation options"
);
assertCondition(
  sourceFiles.search.content.includes(naverBlogSearchFallback),
  "src/lib/search.js: Naver search fallback URL must use the blog tab"
);
assertCondition(
  sourceFiles.accountStore.content.includes("searchChannel: normalizeSearchChannel(category?.searchChannel)")
    && sourceFiles.accountStore.content.includes("[\"blog\", \"news\", \"web\"].includes(value)")
    && sourceFiles.accountStore.content.includes("primarySearchProvider: normalizeSearchProvider(category?.primarySearchProvider")
    && sourceFiles.accountStore.content.includes("fallbackSearchProvider: normalizeSearchProvider(category?.fallbackSearchProvider")
    && sourceFiles.accountStore.content.includes("trustBlogAsSource: category?.trustBlogAsSource === true"),
  "src/lib/accountStore.js: category search channel, providers, and blog trust settings must be normalized"
);
assertCondition(
  sourceFiles.rendererIndex.content.includes("categorySearchChannel")
    && sourceFiles.rendererIndex.content.includes("value=\"news\"")
    && sourceFiles.rendererIndex.content.includes("categoryPrimarySearchProvider")
    && sourceFiles.rendererIndex.content.includes("categoryFallbackSearchProvider")
    && sourceFiles.rendererIndex.content.includes("categoryTrustBlogAsSource"),
  "src/renderer/index.html: category manager must expose search channel, providers, and blog trust controls"
);
assertCondition(
  sourceFiles.rendererApp.content.includes("function normalizeSearchChannel")
    && sourceFiles.rendererApp.content.includes("[\"blog\", \"news\", \"web\"].includes(normalized)")
    && sourceFiles.rendererApp.content.includes("function searchChannelLabel")
    && sourceFiles.rendererApp.content.includes("searchChannel: normalizeSearchChannel(category?.searchChannel)")
    && sourceFiles.rendererApp.content.includes("function categorySearchProviders")
    && sourceFiles.rendererApp.content.includes("primarySearchProvider: searchProviders.primarySearchProvider")
    && sourceFiles.rendererApp.content.includes("fallbackSearchProvider: searchProviders.fallbackSearchProvider")
    && sourceFiles.rendererApp.content.includes("trustBlogAsSource: category?.trustBlogAsSource === true"),
  "src/renderer/app.js: category search settings must be included in collected run form"
);
assertCondition(
  sourceFiles.main.content.includes("searchChannel: form.searchChannel || \"blog\"")
    && sourceFiles.main.content.includes("primarySearchProvider: form.primarySearchProvider || \"naver\"")
    && sourceFiles.main.content.includes("fallbackSearchProvider: form.fallbackSearchProvider || \"google\"")
    && sourceFiles.main.content.includes("trustBlogAsSource: form.trustBlogAsSource === true"),
  "src/main.js: category search settings must flow into generation and search callbacks"
);
assertCondition(
  naverPublisherPrivate.shouldUseReservedPublishSchedule?.({
    publishVisibility: "private",
    publishPrivate: true,
    publishScheduleMode: "reserve"
  }) === false
    && naverPublisherPrivate.shouldUseReservedPublishSchedule?.({
      publishVisibility: "public",
      publishPrivate: false,
      publishScheduleMode: "reserve"
    }) === true,
  "src/lib/naverPublisher.js: private publishing must force current publish instead of reserved publish"
);
const overnightReserveParts = naverPublisherPrivate.getReservedDateParts?.(3, new Date(2026, 5, 20, 22, 37, 0));
assertCondition(
  overnightReserveParts?.date === "2026. 06. 21"
    && overnightReserveParts?.hour === "01"
    && overnightReserveParts?.minute === "40",
  "src/lib/naverPublisher.js: reserved publishing must increment date when the offset crosses midnight"
);
const finalPublishClickBlock = extractFunctionBlock(sourceFiles.naverPublisher, "async function clickFinalPublishButton", "final publish button click function");
const publishSettingsLayerBlock = extractFunctionBlock(sourceFiles.naverPublisher, "async function waitForPublishSettingsLayer", "publish settings layer wait function");
const publishScheduleBlock = extractFunctionBlock(sourceFiles.naverPublisher, "async function applyPublishSchedule", "publish schedule function");
assertCondition(
  sourceFiles.naverPublisher.content.includes("async function clickFinalPublishButton(page, selectors, log, options = {})")
    && sourceFiles.naverPublisher.content.includes("clickFinalPublishButton(page, selectors, log, options)")
    && sourceFiles.naverPublisher.content.includes("button[data-testid='seOnePublishBtn']")
    && sourceFiles.naverPublisher.content.includes("button[data-click-area='tpb*i.publish']")
    && sourceFiles.naverPublisher.content.includes("function isPublishSettingsButtonMeta")
    && sourceFiles.naverPublisher.content.includes("function isReservedPostListButtonText")
    && sourceFiles.naverPublisher.content.includes("function isReservedPostListButtonMeta")
    && sourceFiles.naverPublisher.content.includes("async function clickPublishSettingsButton(page, selectors, log)")
    && sourceFiles.naverPublisher.content.includes("async function waitForPublishSettingsLayer(page, selectors, log")
    && sourceFiles.naverPublisher.content.includes("input[class*='input_date'][readonly][type='text']")
    && sourceFiles.naverPublisher.content.includes("node.setAttribute(\"value\", nextValue)"),
  "src/lib/naverPublisher.js: reserved/current publish automation must use mode-aware final buttons and robust readonly date input"
);
assertCondition(
  finalPublishClickBlock && !finalPublishClickBlock.content.includes("[data-click-area='tpb.publish']"),
  "src/lib/naverPublisher.js: final publish click must not include the first publish-settings button selector"
);
assertCondition(
  finalPublishClickBlock && !finalPublishClickBlock.content.includes("has-text('발행')"),
  "src/lib/naverPublisher.js: final publish click must avoid broad text selectors that can click reserved-post list buttons"
);
assertCondition(
  finalPublishClickBlock && !finalPublishClickBlock.content.includes("isReservePublishButtonText"),
  "src/lib/naverPublisher.js: final publish click must not reject seOnePublishBtn just because its visible text is 발행"
);
assertCondition(
  publishSettingsLayerBlock
    && publishSettingsLayerBlock.content.includes("selectors.finalPublishButton")
    && !publishSettingsLayerBlock.content.includes("selectors.categoryButton")
    && !publishSettingsLayerBlock.content.includes("selectors.tagInput"),
  "src/lib/naverPublisher.js: publish settings layer detection must require final publish controls, not generic category/tag controls"
);
assertCondition(
  publishScheduleBlock
    && publishScheduleBlock.content.includes("waitForPublishSettingsLayer(page, selectors, log")
    && publishScheduleBlock.content.includes("findPublishScheduleOption(page, selectors.reserveOption")
    && !publishScheduleBlock.content.includes("clickVisibleMenuText(page"),
  "src/lib/naverPublisher.js: reserved publish option must only be clicked inside a verified publish layer and must not use broad text fallback"
);
assertCondition(
  sourceFiles.naverPublisher.content.includes("button[data-click-area='tpb.publish']")
    && sourceFiles.naverPublisher.content.includes("button[class*='publish_btn__']")
    && !sourceFiles.naverPublisher.content.includes("button:text-is('발행')")
    && !sourceFiles.naverPublisher.content.includes("[role='button']:has-text('발행')")
    && !sourceFiles.naverPublisher.content.includes("button:has(span:text-is('발행'))"),
  "src/lib/naverPublisher.js: first publish button must use element selectors instead of broad 발행 text fallbacks"
);

assertCondition(
  typeof searchLib.summarizeSourceQuality === "function",
  "src/lib/search.js: source quality summarizer must be exported for runtime and checks"
);
assertCondition(
  searchPrivate.isLowValueResult?.("feedback", "https://support.google.com/websearch") === true,
  "src/lib/search.js: generic support/search-help pages must be filtered before content extraction"
);
assertCondition(
  searchPrivate.isUnsupportedContentUrl?.("https://example.com/report.xlsx") === true
    && searchPrivate.isLowValueResult?.("PDF", "https://example.com/file.pdf") === true,
  "src/lib/search.js: non-HTML document URLs must be filtered before content extraction"
);
assertCondition(
  searchPrivate.naverSearchTemplateFor?.({ searchChannel: "blog" }) === naverBlogSearchTemplate
    && searchPrivate.naverSearchTemplateFor?.({ searchChannel: "news" }) === naverNewsSearchTemplate
    && searchPrivate.naverSearchTemplateFor?.({ searchChannel: "web" }) === "https://search.naver.com/search.naver?where=web&query={query}",
  "src/lib/search.js: category search channel must select Naver blog, news, or web search URLs"
);
const foodSearchQuery = searchPrivate.buildQueryText?.(
  "생생정보통에 소개된 최신 맛집 중 독자가 실제 방문 전 확인해야 할 메뉴, 위치, 주변 볼거리 정보를 함께 정리하는 방향이 적합하다.",
  "생생정보통 맛집 추천",
  "auto"
);
assertCondition(
  typeof foodSearchQuery === "string"
    && foodSearchQuery.startsWith("생생정보통 맛집 추천")
    && foodSearchQuery.length <= 90
    && !foodSearchQuery.includes("적합하다"),
  "src/lib/search.js: automatic food/news searches must prioritize compact category keywords over long Research topicThesis sentences"
);
assertCondition(
  searchPrivate.candidateMatchesSearchIntent?.(
    { title: "생생정보통 오늘 맛집 위치", url: "https://example.com/post" },
    { topic: "생생정보통 맛집 추천", keyword: "생생정보통 맛집 추천" }
  ) === true
    && searchPrivate.candidateMatchesSearchIntent?.(
      { title: "기초학문자료센터 XLS", url: "https://www.krm.or.kr/data/frbr/file.xlsx" },
      { topic: "생생정보통 맛집 추천", keyword: "생생정보통 맛집 추천" }
    ) === false,
  "src/lib/search.js: search candidates must match keyword intent before fetch attempts"
);
const longBroadcastQuery = searchPrivate.buildQueryText?.(
  "가장 최근 전현무계획 방송에 나온 맛집 소개",
  "전현무계획 맛집, 전현무계획 오늘 맛집, 전현무계획 지역 맛집, 전현무계획 식당 위치, 전현무계획 메뉴 가격, 백반기행 맛집, 생생정보 맛집, 6시내고향 맛집",
  "auto"
);
assertCondition(
  typeof longBroadcastQuery === "string" && longBroadcastQuery.length <= 260 && !longBroadcastQuery.includes("6시내고향 맛집"),
  "src/lib/search.js: automatic search queries must be compacted instead of sending every category keyword"
);
assertCondition(
  JSON.stringify(searchPrivate.normalizeSearchQueries?.([
    "OpenAI copyright lawsuit latest filing",
    "OpenAI copyright lawsuit latest filing",
    "The New York Times OpenAI Microsoft copyright lawsuit",
    "AI copyright court document 2026",
    "OpenAI settlement status 2026"
  ])) === JSON.stringify([
    "OpenAI copyright lawsuit latest filing",
    "The New York Times OpenAI Microsoft copyright lawsuit",
    "AI copyright court document 2026",
    "OpenAI settlement status 2026"
  ]),
  "src/lib/search.js: Research/Title searchQueries must stay deduped separate query variants"
);
assertCondition(
  sourceFiles.search.content.includes("queryOverride")
    && sourceFiles.search.content.includes("Narrow search query:")
    && sourceFiles.search.content.includes("includeNaverWebFallback")
    && sourceFiles.search.content.includes("forceAllProviders: profile.strictEvidence"),
  "src/lib/search.js: strict search must run separate Research/Title query variants and avoid early provider cutoff"
);
assertCondition(
  sourceFiles.search.content.includes("MIN_SELECTED_CANDIDATES_BEFORE_FALLBACK = 5")
    && sourceFiles.search.content.includes("function shouldRunFallbackForSparseSelection")
    && sourceFiles.search.content.includes("Selected source candidates below")
    && sourceFiles.search.content.includes("collectRawCandidates(\"\", [fallback]"),
  "src/lib/search.js: sparse selected candidates must trigger one fallback provider search without locale/language hardcoding"
);
const strictSearchOptions = {
  searchNeed: "strict",
  topic: "2026 소상공인 정책자금 신청 대상",
  keyword: "소상공인정책자금, 소상공인공고",
  researchGuidance: "공고 신청 기간 대상 자격 확인"
};
const strictProfile = searchPrivate.buildSearchProfile?.(strictSearchOptions);
const institutionalRelevance = searchPrivate.scoreCandidate?.({
  title: "소상공인24 소상공인정책자금 신청 대상 공고",
  url: "https://www.sbiz.or.kr/cot/cm/intro.do",
  excerpt: "2026년 소상공인정책자금 신청 기간과 지원 대상, 자격, 공고 내용을 안내합니다."
}, ["소상공인정책자금", "신청", "대상"], strictSearchOptions, strictProfile);
assertCondition(
  institutionalRelevance?.institutionalSource === true && institutionalRelevance?.currentFactSignal === true,
  "src/lib/search.js: institutional current sources must be recognized without category-specific site hardcoding"
);
const institutionalSummary = searchLib.summarizeSourceQuality?.([{
  title: "소상공인24 소상공인정책자금 신청 대상 공고",
  url: "https://www.sbiz.or.kr/cot/cm/intro.do",
  contentLength: 420,
  excerpt: "2026년 소상공인정책자금 신청 기간과 지원 대상, 자격, 공고 내용을 안내합니다.",
  relevance: institutionalRelevance
}], "auto", { searchNeed: "strict" });
assertCondition(
  institutionalSummary?.status === "usable" && institutionalSummary?.strongEvidenceCandidates === 1,
  "src/lib/search.js: strict source quality must accept reliable current institutional evidence"
);
const strictBlogOptions = {
  searchNeed: "strict",
  topic: "생생정보통 맛집 추천",
  keyword: "생생정보통 맛집 추천",
  researchGuidance: "공식 최신 출처와 현재 운영 정보 확인",
  trustBlogAsSource: true
};
const strictBlogProfile = searchPrivate.buildSearchProfile?.(strictBlogOptions);
const trustedBlogRelevance = searchPrivate.scoreCandidate?.({
  title: "생생정보통 맛집 추천 방문 후기",
  url: "https://blog.naver.com/sample/223000000000",
  excerpt: "2026년 6월 20일 기준 메뉴, 위치, 영업시간, 예약, 주차 정보를 직접 방문 후 정리했습니다."
}, ["생생정보통", "맛집", "추천"], strictBlogOptions, strictBlogProfile);
assertCondition(
  trustedBlogRelevance?.blogTrustedSource === true
    && trustedBlogRelevance?.lowTrustSource === false
    && searchPrivate.hasStrongEvidence?.({ relevance: trustedBlogRelevance }) === true,
  "src/lib/search.js: trusted Naver blog categories must allow directly relevant current blog evidence"
);
const strictUntrustedBlogOptions = { ...strictBlogOptions, trustBlogAsSource: false };
const strictUntrustedBlogProfile = searchPrivate.buildSearchProfile?.(strictUntrustedBlogOptions);
const untrustedBlogRelevance = searchPrivate.scoreCandidate?.({
  title: "생생정보통 맛집 추천 방문 후기",
  url: "https://blog.naver.com/sample/223000000000",
  excerpt: "2026년 6월 20일 기준 메뉴, 위치, 영업시간, 예약, 주차 정보를 직접 방문 후 정리했습니다."
}, ["생생정보통", "맛집", "추천"], strictUntrustedBlogOptions, strictUntrustedBlogProfile);
assertCondition(
  untrustedBlogRelevance?.blogTrustedSource !== true
    && untrustedBlogRelevance?.lowTrustSource === true
    && searchPrivate.hasStrongEvidence?.({ relevance: untrustedBlogRelevance }) === false,
  "src/lib/search.js: untrusted blog categories must keep Naver blog evidence out of strict strong evidence"
);
const industryStrictOptions = {
  searchNeed: "strict",
  topic: "NVIDIA Blackwell 공급망, B200·GB200 출하가 AI 반도체 경쟁을 흔드는 이유",
  keyword: "AI 업계동향, AI 시장, AI 기업동향, AI 반도체, NVIDIA",
  category: "AI 업계동향",
  publishPurpose: "현재 확인 가능한 AI 기업 동향, 모델 출시, 기술 발표, 투자, 시장 변화, 반도체, 오픈소스 AI, 빅테크 경쟁 정보를 다룬다. 공식 또는 신뢰 가능한 출처에서 현재성을 확인한다.",
  researchGuidance: "NVIDIA 공식 뉴스룸 Investor Relations 실적자료 Reuters 등 신뢰 가능한 매체에서 Blackwell 생산 출하 매출 공급망 currentPeg를 확인",
  searchQueries: ["NVIDIA Blackwell B200 GB200 production ramp official investor relations"],
  trustBlogAsSource: true
};
const industryStrictProfile = searchPrivate.buildSearchProfile?.(industryStrictOptions);
assertCondition(
  industryStrictProfile?.strictEvidence === true
    && industryStrictProfile?.authorityEvidence === false
    && !sourceFiles.main.content.includes("if (searchNeed === \"strict\") return true;"),
  "src/lib/search.js and src/main.js: strict industry/current topics must not be forced into official notice/application authority re-search"
);
const aiLaunchOptions = {
  searchNeed: "strict",
  topic: "Google I/O 2026 Gemini Spark and Gemini 3.5 Flash launch announcement",
  keyword: "AI industry trend, Google AI, Gemini, AI agent",
  category: "AI industry trend",
  publishPurpose: "current AI company trend, model launch, technology announcement, market reaction",
  researchGuidance: "Google I/O 2026 Gemini Spark Gemini 3.5 Flash announcement coverage",
  searchQueries: ["Google I/O 2026 Gemini Spark Gemini 3.5 Flash announcement coverage"],
  trustBlogAsSource: true
};
const aiLaunchProfile = searchPrivate.buildSearchProfile?.(aiLaunchOptions);
const aiBlogRelevance = searchPrivate.scoreCandidate?.({
  title: "Google I/O 2026 Gemini Spark 블로그 정리",
  url: "https://blog.naver.com/sample/224000000001",
  excerpt: "2026.05.22 Google I/O 2026 Gemini Spark Gemini 3.5 Flash 발표 내용을 정리했습니다."
}, ["google", "gemini", "spark", "flash"], aiLaunchOptions, aiLaunchProfile);
const aiEditorialRelevance = searchPrivate.scoreCandidate?.({
  title: "Google I/O 2026 Gemini Spark and Gemini 3.5 Flash announcement coverage",
  url: "https://tech.example.com/news/google-io-2026-gemini-spark-flash",
  excerpt: "Published May 22, 2026. The report covers Google I/O 2026, Gemini Spark, Gemini 3.5 Flash, launch context, and AI agent market implications."
}, ["google", "gemini", "spark", "flash"], aiLaunchOptions, aiLaunchProfile);
const aiBlogOnlySummary = searchLib.summarizeSourceQuality?.([{
  title: "Google I/O 2026 Gemini Spark 블로그 정리",
  url: "https://blog.naver.com/sample/224000000001",
  contentLength: 420,
  excerpt: "2026.05.22 Google I/O 2026 Gemini Spark Gemini 3.5 Flash 발표 내용을 정리했습니다.",
  relevance: aiBlogRelevance
}], "auto", aiLaunchOptions);
const aiEditorialSummary = searchLib.summarizeSourceQuality?.([{
  title: "Google I/O 2026 Gemini Spark and Gemini 3.5 Flash announcement coverage",
  url: "https://tech.example.com/news/google-io-2026-gemini-spark-flash",
  contentLength: 620,
  excerpt: "Published May 22, 2026. The report covers Google I/O 2026, Gemini Spark, Gemini 3.5 Flash, launch context, and AI agent market implications.",
  relevance: aiEditorialRelevance
}], "auto", aiLaunchOptions);
assertCondition(
  aiLaunchProfile?.strictEvidence === true
    && aiLaunchProfile?.authorityEvidence === false
    && aiLaunchProfile?.independentEvidence === true
    && aiBlogRelevance?.blogTrustedSource === true
    && aiBlogRelevance?.independentSource !== true
    && searchPrivate.hasStrongEvidence?.({ relevance: aiBlogRelevance }) === false
    && aiBlogOnlySummary?.status === "insufficient"
    && aiBlogOnlySummary?.independentEvidenceRequired === true
    && aiBlogOnlySummary?.trustedBlogDiscoveryCandidates === 1,
  "src/lib/search.js: AI/technology launch topics must not pass strict source quality from Naver blog candidates alone"
);
assertCondition(
  aiEditorialRelevance?.independentSource === true
    && searchPrivate.hasStrongEvidence?.({ relevance: aiEditorialRelevance }) === true
    && aiEditorialSummary?.status === "usable"
    && aiEditorialSummary?.independentEvidenceCandidates === 1
    && Array.isArray(aiEditorialSummary?.independentEvidenceSources)
    && aiEditorialSummary.independentEvidenceSources[0]?.url.includes("tech.example.com"),
  "src/lib/search.js: AI/technology launch topics must accept non-hardcoded independent editorial evidence"
);
assertCondition(
  sourceFiles.search.content.includes("focusedIndependentSearchSuffix")
    && sourceFiles.search.content.includes("독립 신뢰 근거가 필요한 검색")
    && sourceFiles.search.content.includes("independentRefined"),
  "src/lib/search.js: missing independent evidence must trigger broad web re-search and prioritized crawling"
);
for (const hardcodedMediaName of ["theverge.com", "techcrunch.com", "businessinsider.com", "techradar.com", "reuters.com", "bloomberg.com"]) {
  assertCondition(
    !sourceFiles.search.content.toLowerCase().includes(hardcodedMediaName),
    "src/lib/search.js: independent media trust must not be implemented as a hardcoded media-domain allowlist"
  );
}
const policyBlogOptions = {
  searchNeed: "strict",
  topic: "소상공인 정책자금 지원사업 신청 공고",
  keyword: "소상공인정책자금, 소상공인지원금",
  researchGuidance: "지원금 신청 대상 마감 공식 공고 확인",
  trustBlogAsSource: true
};
const policyBlogProfile = searchPrivate.buildSearchProfile?.(policyBlogOptions);
const policyBlogRelevance = searchPrivate.scoreCandidate?.({
  title: "소상공인 정책자금 신청 공고 정리",
  url: "https://blog.naver.com/sample/224000000000",
  excerpt: "2026년 6월 기준 소상공인시장진흥공단 정책자금 신청 대상, 접수 기간, 마감, 공식 공고 확인 방법을 정리했습니다."
}, ["소상공인정책자금", "신청", "공고"], policyBlogOptions, policyBlogProfile);
const policyBlogSummary = searchLib.summarizeSourceQuality?.([{
  title: "소상공인 정책자금 신청 공고 정리",
  url: "https://blog.naver.com/sample/224000000000",
  contentLength: 420,
  excerpt: "2026년 6월 기준 소상공인시장진흥공단 정책자금 신청 대상, 접수 기간, 마감, 공식 공고 확인 방법을 정리했습니다.",
  relevance: policyBlogRelevance
}], "auto", { searchNeed: "strict" });
assertCondition(
  policyBlogProfile?.authorityEvidence === true
    && policyBlogRelevance?.blogTrustedSource === true
    && searchPrivate.hasStrongEvidence?.({ relevance: policyBlogRelevance }) === false
    && policyBlogSummary?.status === "insufficient"
    && policyBlogSummary?.authorityEvidenceRequired === true
    && policyBlogSummary?.trustedBlogDiscoveryCandidates === 1,
  "src/lib/search.js: authority-required categories must use trusted blogs as discovery only until official/institutional evidence is found"
);
const extractedAuthorityLinks = searchPrivate.extractAuthorityLinks?.(
  '<a href="https://ols.semas.or.kr/ols/man/SMAN010M/page.do">소상공인정책자금 공식 누리집</a>'
    + '<a href="https://blog.naver.com/sample/1">블로그 후기</a>',
  "https://blog.naver.com/sample/224000000000"
);
assertCondition(
  Array.isArray(extractedAuthorityLinks)
    && extractedAuthorityLinks.length === 1
    && extractedAuthorityLinks[0].url.includes("ols.semas.or.kr"),
  "src/lib/search.js: trusted blog body links to official/institutional sources must be extracted as follow-up candidates"
);
const existingTwenty = Array.from({ length: 20 }, (_item, index) => ({
  title: `blog-${index}`,
  url: `https://blog.naver.com/sample/${index}`
}));
const prioritizedMerge = searchPrivate.mergeCandidateLists?.(
  [{ title: "official", url: "https://ols.semas.or.kr/ols/man/SMAN010M/page.do" }],
  existingTwenty,
  20
);
assertCondition(
  Array.isArray(prioritizedMerge)
    && prioritizedMerge.length === 20
    && prioritizedMerge[0]?.url.includes("ols.semas.or.kr"),
  "src/lib/search.js: official follow-up candidates must not be truncated behind the first 20 blog results"
);
const strictAuthorityProfile = searchPrivate.buildSearchProfile?.({
  searchNeed: "strict",
  topic: "정책자금 공식 공고",
  keyword: "소상공인 정책자금 신청"
});
const officialAfterTwenty = searchPrivate.buildCandidateFetchList?.(
  [
    ...existingTwenty,
    { title: "official late result", url: "https://ols.semas.or.kr/ols/man/SMAN010M/page.do" }
  ],
  strictAuthorityProfile,
  20
);
assertCondition(
  Array.isArray(officialAfterTwenty)
    && officialAfterTwenty.length === 20
    && officialAfterTwenty[0]?.url.includes("ols.semas.or.kr")
    && officialAfterTwenty.some((item) => String(item?.url || "").includes("ols.semas.or.kr")),
  "src/lib/search.js: strict source collection must preserve official/institutional candidates even when they appear after the first 20 raw results"
);
const nonStrictFetchList = searchPrivate.buildCandidateFetchList?.(
  [
    ...existingTwenty,
    { title: "official late result", url: "https://ols.semas.or.kr/ols/man/SMAN010M/page.do" }
  ],
  { strictEvidence: false },
  20
);
assertCondition(
  Array.isArray(nonStrictFetchList)
    && nonStrictFetchList.length === 20
    && nonStrictFetchList[0]?.url.includes("/sample/0")
    && !nonStrictFetchList.some((item) => String(item?.url || "").includes("ols.semas.or.kr")),
  "src/lib/search.js: non-strict source collection should keep the existing first-20 behavior"
);
assertCondition(
  sourceFiles.search.content.includes("블로그 본문에서 직접 공식 링크를 찾지 못해 기관명/사업명 단서로 공식사이트를 재검색합니다.")
    && sourceFiles.search.content.includes("authorityRefined")
    && sourceFiles.search.content.includes("buildCandidateFetchList")
    && sourceFiles.search.content.includes("공식사이트 보강 검색을 실행합니다."),
  "src/lib/search.js: missing official links in blogs must trigger official-site re-search and prioritized crawling"
);
const industryEvidenceTerms = searchPrivate.selectEvidenceSearchTerms?.({
  searchNeed: "strict",
  topic: "한화오션 2조원대 수주 뒤 조선업 호황은 선가와 LNG 발주로 이어질까",
  keyword: "조선업 수주 전망",
  researchGuidance: "공식 공시 IR 자료 클락슨 신조선가지수 신용평가 보고서 원문 확인",
  searchQueries: ["한화오션 LNG 운반선 VLCC 수주 공시", "Clarksons 신조선가지수 조선업 전망 보고서"]
});
assertCondition(
  typeof industryEvidenceTerms === "string"
    && industryEvidenceTerms.includes("공시")
    && industryEvidenceTerms.includes("IR")
    && industryEvidenceTerms.includes("보고서")
    && industryEvidenceTerms.includes("지표")
    && !industryEvidenceTerms.includes("신청 조건"),
  "src/lib/search.js: official re-search suffix must adapt to evidence type instead of using application/notice wording for industry topics"
);
assertCondition(
  sourceFiles.main.content.includes("function collectAuthorityEvidenceTerms")
    && sourceFiles.main.content.includes("function collectAuthoritySubjectPhrases")
    && !sourceFiles.main.content.includes("`${selectedTopic} 공식 공고`")
    && !sourceFiles.main.content.includes("`${selectedTopic} 모집 채용 공고`"),
  "src/main.js: authority recheck queries must be built from Research evidence type and subject phrases, not fixed notice/application templates"
);
const irrelevantSummary = searchLib.summarizeSourceQuality?.([{
  title: "feedback",
  url: "https://support.google.com/websearch",
  contentLength: 361,
  excerpt: "Google 검색 고객센터 도움말 센터 검색 도움말 포럼 서비스 약관 의견 보내기",
  relevance: { score: 0, matchedTerms: [] }
}], "auto", { searchNeed: "normal" });
assertCondition(
  irrelevantSummary?.status === "insufficient",
  "src/lib/search.js: source quality must reject extracted text with no direct relevance"
);

assertNotIncludes(
  sourceFiles.main,
  "prepareNaverPostWrite",
  "pre-generation editor-loading preparation in main process"
);
const naverExports = extractBlockAfter(sourceFiles.naverPublisher, "module.exports = ", "Naver publisher exports");
if (naverExports?.content.includes("prepareNaverPostWrite")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: prepareNaverPostWrite must not be exported for pre-generation reuse");
}
const resolveTopicInput = extractFunctionBlock(sourceFiles.main, "async function resolveTopicInput", "resolveTopicInput function");
if (resolveTopicInput && !resolveTopicInput.content.includes("topic: \"\"")) {
  failed = true;
  console.error("src/main.js: auto topic mode must not reuse stale topic text as a direct topic");
}

const searchTopicSelector = extractFunctionBlock(sourceFiles.main, "function selectSearchTopicForResearch", "selectSearchTopicForResearch function");
if (searchTopicSelector && !searchTopicSelector.content.includes("researchResult?.finalTitle")) {
  failed = true;
  console.error("src/main.js: search topic selection must prefer Research/Title finalTitle over topicThesis for search queries");
}

const generationOptions = extractBlockAfter(sourceFiles.main, "codexResult = await runCodexGeneration(", "main runCodexGeneration options");
if (generationOptions && !generationOptions.content.includes("searchResults: []")) {
  failed = true;
  console.error("src/main.js: initial runCodexGeneration options must pass searchResults: []");
}
if (generationOptions && !generationOptions.content.includes("onSearchNeeded: async")) {
  failed = true;
  console.error("src/main.js: runCodexGeneration options must include onSearchNeeded");
}
const searchCallback = extractBlockAfter(sourceFiles.main, "onSearchNeeded: async", "main onSearchNeeded callback");
if (searchCallback && !searchCallback.content.includes("selectSearchTopicForResearch(researchResult")) {
  failed = true;
  console.error("src/main.js: onSearchNeeded must use compact search topic selection instead of raw topicThesis");
}
if (
  !sourceFiles.main.content.includes("function splitKeywordLanes")
  || !sourceFiles.main.content.includes("function buildKeywordLanePlan")
  || !sourceFiles.main.content.includes("function keywordLaneHistoryFields")
) {
  failed = true;
  console.error("src/main.js: automatic keyword pools must be split into history-aware keyword lanes");
}
if (
  !sourceFiles.main.content.includes("excludedKeywordLanes")
  || !sourceFiles.main.content.includes("keywordLaneResultPayload")
  || !sourceFiles.rendererApp.content.includes("keywordLanePhrasesFromResult")
  || !sourceFiles.rendererApp.content.includes("제외 lane")
) {
  failed = true;
  console.error("auto retry must exclude failed keyword lanes within the same target retry cycle");
}
if (
  searchCallback
  && (!searchCallback.content.includes("normalizeResearchLaneResult(researchResult, keywordLanePlan)")
    || !sourceFiles.main.content.includes("function buildResearchIntentSearchQueries")
    || !sourceFiles.main.content.includes("function buildResearchIntentGuidance")
    || !searchCallback.content.includes("buildResearchIntentSearchQueries(researchResult, laneResult, searchTopic)")
    || !searchCallback.content.includes("buildResearchIntentGuidance(researchResult, searchContext)")
    || !searchCallback.content.includes("searchQueries: laneResult.searchQueries")
    || searchCallback.content.includes("laneResult.searchQueries.join")
    || searchCallback.content.includes("const searchKeyword = keyword || category"))
) {
  failed = true;
  console.error("src/main.js: search must use selected keyword lane plus Research-derived intent instead of the full category keyword pool");
}
if (
  !sourceFiles.main.content.includes("topic_lane")
  || !sourceFiles.main.content.includes("selected_keyword_phrases")
  || !sourceFiles.main.content.includes("search_queries")
) {
  failed = true;
  console.error("src/main.js: keyword lane choices must always be written to blog history");
}
for (const index of allIndexesOf(sourceFiles.main.content, "collectSearchResults({")) {
  if (!searchCallback || index < searchCallback.start || index > searchCallback.end) {
    failed = true;
    console.error("src/main.js: collectSearchResults must only run inside onSearchNeeded after Research/Title Agent asks for search");
  }
}

const codexGeneration = extractFunctionBlock(sourceFiles.codexRunner, "async function runCodexGeneration", "runCodexGeneration function");
const codexTask = extractFunctionBlock(sourceFiles.codexRunner, "async function runCodexTask", "runCodexTask function");
const codexFeedbackFilter = extractFunctionBlock(sourceFiles.codexRunner, "function isUsefulCodexFeedback", "Codex feedback filter");
const codexResultReader = extractFunctionBlock(sourceFiles.codexRunner, "function readAgentResult", "Codex agent result reader");
if (
  codexGeneration
  && (!codexGeneration.content.includes("writerSupplementSearchUsed")
    || !codexGeneration.content.includes("writerSupplement: true")
    || !codexGeneration.content.includes("Writer Agent가 근거 부족을 감지해 Research/Title 보강 검색을 1회 요청합니다")
    || !codexGeneration.content.includes("research-title-writer-source-search-prompt.txt")
    || !codexGeneration.content.includes("attempt = Math.max(0, attempt - 1)"))
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer source-insufficient failures must trigger one supplemental Research search before final failure");
}
if (
  !sourceFiles.codexRunner.content.includes("researchRevisionContext")
  || !sourceFiles.codexRunner.content.includes("Revision context from previous agent step")
  || !sourceFiles.codexRunner.content.includes("Writer Agent reported insufficient support after Research/Title PASS")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: supplemental Writer source searches must pass revision context into Research/Title prompt");
}
if (
  searchCallback
  && (!searchCallback.content.includes("searchContext.writerSupplement")
    || !searchCallback.content.includes("searchContext.writerIssueReason")
    || !searchCallback.content.includes("Writer Agent 근거 부족 사유로 보강 검색합니다"))
) {
  failed = true;
  console.error("src/main.js: onSearchNeeded must include Writer source-insufficient context in supplemental search guidance");
}
if (codexFeedbackFilter && !codexFeedbackFilter.content.includes("codex_core::tools::router")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Codex internal tool-router errors must be hidden from user-facing logs");
}
if (codexFeedbackFilter && !codexFeedbackFilter.content.includes("ConvertFrom-Json")) {
  failed = true;
  console.error("src/lib/codexRunner.js: PowerShell JSON validation noise must be hidden from user-facing logs");
}
if (
  codexFeedbackFilter
  && (!codexFeedbackFilter.content.includes("Copy-Item")
    || !codexFeedbackFilter.content.includes("AccessException")
    || !codexFeedbackFilter.content.includes("Invoke-WebRequest"))
) {
  failed = true;
  console.error("src/lib/codexRunner.js: PowerShell command errors must be hidden from user-facing logs");
}
if (codexFeedbackFilter && !sourceFiles.codexRunner.content.includes("function looksLikeMojibake")) {
  failed = true;
  console.error("src/lib/codexRunner.js: mojibake Codex output must be filtered before reaching user-facing logs");
}
if (!sourceFiles.codexRunner.content.includes("\"묒\"") || !sourceFiles.codexRunner.content.includes("\"쒕\"") || !sourceFiles.codexRunner.content.includes("\"씤\"")) {
  failed = true;
  console.error("src/lib/codexRunner.js: mojibake filter must cover observed broken Korean Research/Title output fragments");
}
if (codexFeedbackFilter && !codexFeedbackFilter.content.includes("^\"[^\"]+\"\\s*:\\s*")) {
  failed = true;
  console.error("src/lib/codexRunner.js: raw JSON fragments must be hidden from user-facing Codex feedback");
}
if (
  codexFeedbackFilter
  && (!codexFeedbackFilter.content.includes("const inlineJsonFragment")
    || !codexFeedbackFilter.content.includes("inlineJsonFragment.indexOf(\"\\\":\")")
    || !codexFeedbackFilter.content.includes("inlineJsonColonIndex"))
) {
  failed = true;
  console.error("src/lib/codexRunner.js: inline object-shaped JSON fragments must be hidden from user-facing Codex feedback");
}
if (codexResultReader && !codexResultReader.content.includes("try {")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Codex agent result reader must catch JSON parse failures");
}
if (codexResultReader && !codexResultReader.content.includes("Codex Agent 결과 JSON 파싱 실패")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Codex agent JSON parse failures must be summarized without dumping raw result content");
}
if (codexTask && codexTask.content.includes("handleOutputLine(nestedLine, level)")) {
  failed = true;
  console.error("src/lib/codexRunner.js: assistant output from Codex JSON events must not be recursively logged to the UI");
}
if (codexTask && !codexTask.content.includes("assistantProgress = parseProgressLine")) {
  failed = true;
  console.error("src/lib/codexRunner.js: assistant output should only contribute BLOGAUTO_PROGRESS lines");
}
if (codexTask && !codexTask.content.includes("outputState.section === \"assistant\"")) {
  failed = true;
  console.error("src/lib/codexRunner.js: raw assistant sections must be suppressed from user-facing logs");
}
if (codexTask && !codexTask.content.includes("streamBuffers")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Codex JSONL stdout/stderr chunks must be buffered before parsing/logging");
}
if (!sourceFiles.codexRunner.content.includes("function shouldForwardRawCodexOutput")) {
  failed = true;
  console.error("src/lib/codexRunner.js: raw Codex output forwarding must be behind an explicit debug switch");
}
if (codexTask && !codexTask.content.includes("shouldForwardRawCodexOutput(options) && isUsefulCodexFeedback")) {
  failed = true;
  console.error("src/lib/codexRunner.js: raw Codex stdout/stderr must not reach UI logs by default");
}
if (!sourceFiles.codexRunner.content.includes("BLOGAUTO_DEBUG_CODEX_RAW")) {
  failed = true;
  console.error("src/lib/codexRunner.js: raw Codex output debug mode must be explicit");
}
for (const requiredLimitType of [
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]) {
  if (!sourceFiles.codexRunner.content.includes(requiredLimitType)) {
    failed = true;
    console.error(`src/lib/codexRunner.js: Codex usage-limit detection must include ${requiredLimitType}`);
  }
}
if (codexTask && !codexTask.content.includes("\"--json\"")) {
  failed = true;
  console.error("src/lib/codexRunner.js: codex exec must use --json so rate_limit_reached_type can be read exactly");
}
if (codexTask && !codexTask.content.includes("detectCodexUsageLimitSignal(line)")) {
  failed = true;
  console.error("src/lib/codexRunner.js: runCodexTask must detect Codex usage limits from the output stream");
}
if (codexTask && !codexTask.content.includes("isCodexUsageLimitError(error)")) {
  failed = true;
  console.error("src/lib/codexRunner.js: xhigh fallback must not retry after Codex usage-limit errors");
}
if (sourceFiles.codexRunner.content.includes("CODEX_LIMIT_REACHED_TYPES")) {
  failed = true;
  console.error("src/lib/codexRunner.js: usage-limit handling must not collapse generic rate/credit limits into codex_usage_limit");
}
if (!sourceFiles.codexRunner.content.includes("function jsonRateLimits")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Codex rate_limits JSON must be parsed for usage badges");
}
if (!sourceFiles.codexRunner.content.includes("remainingPercent")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Codex usage badges must expose remainingPercent, not only used_percent");
}
if (codexTask && !codexTask.content.includes("jsonRateLimits(parsedJson)")) {
  failed = true;
  console.error("src/lib/codexRunner.js: runCodexTask must collect rate_limits from JSON token_count events");
}
if (codexTask && !codexTask.content.includes("rateLimits: tokenState.rateLimits")) {
  failed = true;
  console.error("src/lib/codexRunner.js: onTokenUsage and tokenUsage must include latest rateLimits");
}
if (codexTask && !codexTask.content.includes("const reportTokenUsage")) {
  failed = true;
  console.error("src/lib/codexRunner.js: token usage reporting must be centralized per Codex task");
}
if (codexTask && !codexTask.content.includes("reportTokenUsage({ final: true })")) {
  failed = true;
  console.error("src/lib/codexRunner.js: each agent must report final token usage when its Codex task completes");
}
if (codexTask && !codexTask.content.includes("agentTotal")) {
  failed = true;
  console.error("src/lib/codexRunner.js: token usage payload must include per-agent totals");
}
if (!sourceFiles.codexRunner.content.includes("function readLatestCodexTokenUsageFromSessions")) {
  failed = true;
  console.error("src/lib/codexRunner.js: must recover token usage from Codex session JSONL when stdout has no token_count event");
}
if (codexTask && !codexTask.content.includes("recoverTokenUsageFromSession")) {
  failed = true;
  console.error("src/lib/codexRunner.js: runCodexTask must call token session fallback before final reporting");
}
if (!sourceFiles.main.content.includes("agentTotal: Number(usage.agentTotal || 0)")) {
  failed = true;
  console.error("src/main.js: token IPC payload must preserve per-agent totals");
}
if (!sourceFiles.main.content.includes("현재 작업 중입니다 - 경과")) {
  failed = true;
  console.error("src/main.js: generation heartbeat must say current work is in progress, not Codex preparation");
}
if (!sourceFiles.codexRunner.content.includes("async function fetchCodexUsageSnapshot")) {
  failed = true;
  console.error("src/lib/codexRunner.js: app startup must have a lightweight Codex usage snapshot reader");
}
if (!sourceFiles.codexRunner.content.includes("readLatestCodexRateLimitsFromSessions")) {
  failed = true;
  console.error("src/lib/codexRunner.js: startup usage refresh must fall back to latest local Codex session rate_limits");
}
if (!sourceFiles.codexRunner.content.includes("codexSessionsRoot")) {
  failed = true;
  console.error("src/lib/codexRunner.js: local Codex session scanning must use the CODEX_HOME/.codex sessions root");
}
if (!sourceFiles.codexRunner.content.includes("\"--ephemeral\"") || !sourceFiles.codexRunner.content.includes("\"--ignore-rules\"")) {
  failed = true;
  console.error("src/lib/codexRunner.js: startup usage snapshot should be ephemeral and ignore project rules");
}
if (!sourceFiles.settings.content.includes("codexRateLimits: null")) {
  failed = true;
  console.error("src/lib/settings.js: settings defaults must include codexRateLimits: null");
}
if (!sourceFiles.main.content.includes("fetchCodexUsageSnapshot")) {
  failed = true;
  console.error("src/main.js: main process must expose startup Codex usage refresh");
}
if (!sourceFiles.main.content.includes("ipcMain.handle(\"codex:refreshUsage\"")) {
  failed = true;
  console.error("src/main.js: codex:refreshUsage IPC must be registered");
}
const codexRefreshHandler = extractBlockAfter(sourceFiles.main, "ipcMain.handle(\"codex:refreshUsage\"", "Codex usage refresh IPC handler");
if (codexRefreshHandler && !codexRefreshHandler.content.includes("try {")) {
  failed = true;
  console.error("src/main.js: codex:refreshUsage must catch refresh failures instead of rejecting the Electron IPC handler");
}
if (codexRefreshHandler && !codexRefreshHandler.content.includes("savedFallback")) {
  failed = true;
  console.error("src/main.js: codex:refreshUsage must return saved rate limits when live usage refresh is unavailable");
}
if (!sourceFiles.codexRunner.content.includes("rate_limits가 포함되지 않아 배지를 갱신하지 못했습니다")) {
  failed = true;
  console.error("src/lib/codexRunner.js: missing Codex rate_limits during usage refresh must be treated as badge refresh unavailable, not a fatal job error");
}
if (!sourceFiles.main.content.includes("persistCodexRateLimits(runtimeRoot, jobTokenUsage.rateLimits)")) {
  failed = true;
  console.error("src/main.js: latest Codex rate limits must be persisted after terminal jobs");
}
if (!sourceFiles.main.content.includes("rateLimits: jobTokenUsage.rateLimits")) {
  failed = true;
  console.error("src/main.js: job token/complete payloads must carry rateLimits");
}
if (!sourceFiles.preload.content.includes("refreshCodexUsage")) {
  failed = true;
  console.error("src/preload.js: renderer must be able to request startup Codex usage refresh");
}
if (!sourceFiles.rendererIndex.content.includes("codexWeeklyLimitBadge")) {
  failed = true;
  console.error("src/renderer/index.html: topbar must include the weekly Codex usage badge");
}
if (sourceFiles.rendererIndex.content.includes("codexPrimaryLimitBadge") || sourceFiles.rendererIndex.content.includes("codexSecondaryLimitBadge")) {
  failed = true;
  console.error("src/renderer/index.html: topbar must not show obsolete primary/secondary Codex usage badges");
}
if (!sourceFiles.rendererApp.content.includes("refreshCodexUsageOnStartup")) {
  failed = true;
  console.error("src/renderer/app.js: renderer must refresh Codex usage once on startup");
}
if (!sourceFiles.rendererApp.content.includes("initial.settings?.codexRateLimits")) {
  failed = true;
  console.error("src/renderer/app.js: renderer must initialize badges from saved codexRateLimits");
}
if (!sourceFiles.rendererApp.content.includes("payload.rateLimits") || !sourceFiles.rendererApp.content.includes("payload.tokenUsage?.rateLimits")) {
  failed = true;
  console.error("src/renderer/app.js: renderer must update usage badges from live and complete events");
}
if (!sourceFiles.rendererApp.content.includes("remainingPercent")) {
  failed = true;
  console.error("src/renderer/app.js: renderer must display remaining percent values");
}
if (
  !sourceFiles.rendererApp.content.includes("function weeklyCodexLimitWindow")
  || !sourceFiles.rendererApp.content.includes("Number(limitWindow.windowMinutes) === 10080")
  || sourceFiles.rendererApp.content.includes("5시간 잔량")
) {
  failed = true;
  console.error("src/renderer/app.js: renderer must display only the weekly Codex usage limit and select it by window duration");
}
if (!sourceFiles.main.content.includes("error.code === \"CODEX_USAGE_LIMIT\" ? \"codex_usage_limit\"")) {
  failed = true;
  console.error("src/main.js: CODEX_USAGE_LIMIT must map to codex_usage_limit job status");
}
if (!sourceFiles.rendererApp.content.includes("result?.status === \"codex_usage_limit\"")) {
  failed = true;
  console.error("src/renderer/app.js: automatic loop must stop when Codex usage limit is reached");
}
if (codexGeneration && !codexGeneration.content.includes("const validSearchNeeds = new Set([\"skip\", \"light\", \"normal\", \"strict\"])")) {
  failed = true;
  console.error("src/lib/codexRunner.js: runCodexGeneration must define the strict searchNeed enum");
}
const researchSourceFailure = extractFunctionBlock(sourceFiles.codexRunner, "function isResearchSourceFailure", "Research source failure classifier");
if (codexGeneration && !codexGeneration.content.includes("isResearchSourceFailure(researchResult)")) {
  failed = true;
  console.error("src/lib/codexRunner.js: adaptive Research/Title search retry must use the source failure classifier");
}
if (researchSourceFailure && !researchSourceFailure.content.includes("searchNeed")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research source failure classifier must only trigger for explicit searchNeed values");
}
if (researchSourceFailure && (!researchSourceFailure.content.includes("insufficient") || !researchSourceFailure.content.includes("official"))) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research source failure classifier must cover source and official-evidence failures");
}
if (codexGeneration && !codexGeneration.content.includes("if (!validSearchNeeds.has(requestedSearchNeed))")) {
  failed = true;
  console.error("src/lib/codexRunner.js: runCodexGeneration must fail invalid searchNeed values");
}
if (
  codexGeneration
  && !codexGeneration.content.includes("const finalTitle = String(researchResult.finalTitle || \"\").trim();")
  && !codexGeneration.content.includes("let finalTitle = String(researchResult.finalTitle || \"\").trim();")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: finalTitle must come only from Research/Title finalTitle");
}
if (codexGeneration && !codexGeneration.content.includes("if (!finalTitle)")) {
  failed = true;
  console.error("src/lib/codexRunner.js: missing Research/Title finalTitle must fail before Writer");
}
if (codexGeneration && !codexGeneration.content.includes("title: finalTitle || String(writerResult.title || \"\").trim()")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer title must not override Research/Title finalTitle");
}
if (codexGeneration && !codexGeneration.content.includes("buildMainReviewPrompt")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent final review must run after Writer output");
}
if (codexGeneration && !codexGeneration.content.includes("main-review-result.json")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent final review must write a dedicated review result");
}
if (codexGeneration && !codexGeneration.content.includes("(mainReviewStatus === \"REVISION\" || mainReviewPassIssue) && attempt < maxReviewAttempts")) {
  failed = true;
  console.error("src/lib/codexRunner.js: REVISION Main Agent review must retry before blocking publishing");
}
if (codexGeneration && !codexGeneration.content.includes("Main Agent 수정 요청으로 다시 시도합니다")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent revision retry must be visible in logs");
}
if (codexGeneration && !codexGeneration.content.includes("retryableWriterFailureReason(writerResult")) {
  failed = true;
  console.error("src/lib/codexRunner.js: retryable Writer date-leak failures must be detected");
}
if (codexGeneration && !codexGeneration.content.includes("Writer Agent 작성 실패")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer failures must be logged with the reason before stopping or retrying");
}
if (codexGeneration && !codexGeneration.content.includes("Research/Title Agent가 본문 작성 가능 상태가 아닙니다")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research/Title REVISION must stop before wasting Writer attempts");
}
if (!sourceFiles.codexRunner.content.includes("function writerOutputIssueReason")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer output must have a structural failure gate before Main review");
}
if (!sourceFiles.codexRunner.content.includes("function buildWriterContract")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer drift prevention must use a compact writerContract handoff");
}
const researchTitlePrompt = extractFunctionBlock(sourceFiles.codexRunner, "function buildResearchTitlePrompt", "Research/Title Agent prompt");
if (researchTitlePrompt && !researchTitlePrompt.content.includes("writerContract")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research/Title Agent must return writerContract for Writer anchoring");
}
if (researchTitlePrompt && !researchTitlePrompt.content.includes("compact Writer handoff")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research/Title Agent must describe writerContract as a compact Writer handoff");
}
if (researchTitlePrompt && !researchTitlePrompt.content.includes("Preferred tone is provided, it is the highest style signal")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research/Title Agent must prioritize explicit Preferred tone for title and writerContract style");
}
if (
  researchTitlePrompt
  && (!researchTitlePrompt.content.includes("Naver-home title judgment")
    || !researchTitlePrompt.content.includes("not a template filler")
    || !researchTitlePrompt.content.includes("Build at least three titleCandidates from different editorial angles")
    || !researchTitlePrompt.content.includes("Treat Current writing date as an internal freshness reference")
    || !researchTitlePrompt.content.includes("Do not append a generic freshness or preparation suffix")
    || !researchTitlePrompt.content.includes("the selected topicLane is only a discovery lane")
    || !researchTitlePrompt.content.includes("Do not PASS a lane-level or category-level title")
    || !researchTitlePrompt.content.includes("describe the missing facts and discovery intent")
    || !researchTitlePrompt.content.includes("searchQueries must carry the next-step research intent")
    || !researchTitlePrompt.content.includes("replacing the concrete subject/event with another item from the same keyword lane"))
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research/Title Agent must use an editorial Naver-home title judgment rubric instead of a fixed hook template");
}
const mainReviewPromptForLaneCheck = extractFunctionBlock(sourceFiles.codexRunner, "function buildMainReviewPrompt", "Main review prompt lane check");
if (
  mainReviewPromptForLaneCheck
  && (!mainReviewPromptForLaneCheck.content.includes("keyword-lane or category-level generalization")
    || !mainReviewPromptForLaneCheck.content.includes("swapping in many unrelated subjects from the same selected keyword lane"))
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent must reject vague auto-mode lane-level titles");
}
if (
  !sourceFiles.codexRunner.content.includes("Keyword lanes:")
  || !sourceFiles.codexRunner.content.includes("Recommended keyword lane order from HISTORY")
  || !sourceFiles.codexRunner.content.includes("topicLane")
  || !sourceFiles.codexRunner.content.includes("selectedKeywordIndexes")
  || !sourceFiles.codexRunner.content.includes("searchQueries")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research/Title Agent must select a keyword lane and return searchQueries");
}
if (
  researchTitlePrompt
  && (!researchTitlePrompt.content.includes("Current bridge rule")
    || !researchTitlePrompt.content.includes("anchorEvent")
    || !researchTitlePrompt.content.includes("currentPeg")
    || !researchTitlePrompt.content.includes("currentBridgeRequired")
    || !researchTitlePrompt.content.includes("currentBridgeSatisfied")
    || !researchTitlePrompt.content.includes("make searchQueries seek the currentPeg rather than repeating only the old event"))
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research/Title Agent must distinguish older anchor events from source-backed current pegs");
}
if (
  !sourceFiles.codexRunner.content.includes("function currentBridgeIssueReason")
  || !sourceFiles.codexRunner.content.includes("currentBridgeIssueReason(researchResult)")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: stale current-issue topics must fail when currentBridgeRequired is true but unsatisfied");
}
if (
  !sourceFiles.codexRunner.content.includes("currentBridgeRequired,")
  || !sourceFiles.codexRunner.content.includes("currentBridgeSatisfied,")
  || !sourceFiles.codexRunner.content.includes("anchorEvent,")
  || !sourceFiles.codexRunner.content.includes("currentPeg,")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Contract must carry current bridge fields to Writer and Main Review");
}
if (
  !sourceFiles.codexRunner.content.includes("function compactSearchResultsForPrompt")
  || !sourceFiles.codexRunner.content.includes("maxResults: 6")
  || !sourceFiles.codexRunner.content.includes("excerptChars: 420")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Research/Title search rerun prompt must use compact narrowed source candidates");
}
const compactPromptCandidates = codexRunnerPrivate.compactSearchResultsForPrompt?.([
  {
    sourceId: "naver-1",
    provider: "naver",
    title: "high score blog",
    url: "https://blog.naver.com/sample/1",
    excerpt: "blog discovery candidate",
    relevance: {
      score: 90,
      topicMatchedTerms: ["topic"],
      keywordMatchedTerms: ["keyword"],
      blogTrustedSource: true,
      strictEvidence: true,
      currentFactSignal: true
    }
  },
  {
    sourceId: "official-1",
    provider: "google",
    title: "official application notice",
    url: "https://www.sbiz.or.kr/cot/cm/intro.do",
    excerpt: "official current notice candidate",
    relevance: {
      score: 12,
      topicMatchedTerms: ["topic"],
      keywordMatchedTerms: ["keyword"],
      officialSource: true,
      strictEvidence: true,
      currentFactSignal: true,
      authorityEvidence: true
    }
  }
], { maxResults: 1, excerptChars: 120 });
assertCondition(
  Array.isArray(compactPromptCandidates)
    && compactPromptCandidates.length === 1
    && compactPromptCandidates[0]?.sourceId === "official-1"
    && compactPromptCandidates[0]?.relevance?.officialSource === true
    && compactPromptCandidates[0]?.relevance?.authorityEvidence === true,
  "src/lib/codexRunner.js: official/institutional source candidates must be preserved at the top of compact Research/Title prompt candidates"
);
assertCondition(
  sourceFiles.search.content.includes("authorityEvidenceSources"),
  "src/lib/search.js: source quality summary must expose actual official/institutional candidate sources, not only a count"
);
if (
  !sourceFiles.codexRunner.content.includes("function isMissingCodexResultFileError")
  || !sourceFiles.codexRunner.content.includes("추가 검색 후 Research/Title Agent가 결과 파일을 생성하지 못했습니다.")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: missing Research/Title rerun result files must fall back to the existing research verdict");
}
const mainReviewPrompt = extractFunctionBlock(sourceFiles.codexRunner, "function buildMainReviewPrompt", "Main Agent final review prompt");
if (mainReviewPrompt && !mainReviewPrompt.content.includes("not only title/article matching")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent final review must cover the whole publishability judgment, not only title matching");
}
if (mainReviewPrompt && !mainReviewPrompt.content.includes("Writer contract used for review")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent final review must evaluate the same writerContract used by Writer");
}
if (mainReviewPrompt && !mainReviewPrompt.content.includes("articleMission, selectedTitle, topicThesis, readerPromise, firstSectionFocus, mustAnswer, mustCover, and mustNotDo")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent final review must check writerContract fulfillment");
}
for (const requiredReviewField of [
  "titleReviewPass",
  "articleAnswersTitle",
  "topicPreserved",
  "factualityPass",
  "currentBridgePass",
  "sourceUsePass",
  "bodyQualityPass",
  "riskExpressionPass",
  "writerContractPass",
  "readerFacingArticlePass",
  "noResearchProcessNarrationPass"
]) {
  if (mainReviewPrompt && !mainReviewPrompt.content.includes(requiredReviewField)) {
    failed = true;
    console.error(`src/lib/codexRunner.js: Main Agent final review must include ${requiredReviewField}`);
  }
}
if (!sourceFiles.codexRunner.content.includes("function mainReviewPassIssueReason")) {
  failed = true;
  console.error("src/lib/codexRunner.js: PASS review must be structurally verified before publishing");
}
if (codexGeneration && !codexGeneration.content.includes("mainReviewStatus === \"PASS\" && !mainReviewPassIssue")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent PASS must require all review booleans to pass");
}
if (mainReviewPrompt && !mainReviewPrompt.content.includes("[SECTION - ...] markers are intentional app markers")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent final review must allow app section markers");
}
if (mainReviewPrompt && !mainReviewPrompt.content.includes("not how the agent verified sources")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent final review must reject research-process style article leads");
}
if (
  mainReviewPrompt
  && (!mainReviewPrompt.content.includes("homepage-card title tied to the specific subject")
    || !mainReviewPrompt.content.includes("must not pass only because it has a generic hook phrase")
    || !mainReviewPrompt.content.includes("Date words in the title must be source-backed story material")
    || !mainReviewPrompt.content.includes("Explicit Preferred tone wins style conflicts"))
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent title review must reject generic hook templates while preserving Preferred tone priority");
}
if (
  mainReviewPrompt
  && (!mainReviewPrompt.content.includes("currentBridgeRequired")
    || !mainReviewPrompt.content.includes("currentBridgeSatisfied")
    || !mainReviewPrompt.content.includes("currentBridgePass")
    || !mainReviewPrompt.content.includes("older anchorEvent matters now"))
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent final review must reject stale anchor-event articles without a current bridge");
}
if (mainReviewPrompt && !mainReviewPrompt.content.includes("reads like a stiff report")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent body review must reject stiff report-like default posts");
}
const writerPrompt = extractFunctionBlock(sourceFiles.codexRunner, "function buildPrompt", "Writer Agent prompt");
if (writerPrompt && !writerPrompt.content.includes("This required 기준일 is not a date leak")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must allow required confirmation 기준일 without treating it as date leak");
}
if (writerPrompt && !writerPrompt.content.includes("writerRevisionFeedback")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must accept revision retry feedback");
}
if (writerPrompt && !writerPrompt.content.includes("The article body must never narrate the agent's research process")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must forbid research-process narration in article body");
}
if (writerPrompt && !writerPrompt.content.includes("Category publishing direction is internal guidance")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must prevent category-purpose leakage into the article body");
}
if (writerPrompt && !writerPrompt.content.includes("Never omit the closing bracket")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must require complete SECTION markers");
}
if (writerPrompt && !writerPrompt.content.includes("Writer contract (highest priority)")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must put writerContract before full handoff and sources");
}
if (writerPrompt && !writerPrompt.content.includes("The Writer Contract is the only writing brief")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must treat writerContract as the only writing brief");
}
if (writerPrompt && !writerPrompt.content.includes("Category publishing direction may include topic-selection notes")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must prevent publishPurpose role confusion");
}
if (writerPrompt && !writerPrompt.content.includes("explicit Preferred tone > Writer Contract tone > default human Naver Blog voice")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must prioritize explicit Preferred tone over default human-blog style");
}
if (writerPrompt && !writerPrompt.content.includes("Default human Naver Blog voice")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must define the default human Naver Blog voice");
}
if (
  !sourceFiles.codexRunner.content.includes("readerValueChecklist")
  || !sourceFiles.codexRunner.content.includes("concrete value item")
  || !sourceFiles.codexRunner.content.includes("instead of padding the article")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must require reader-value sections and fail instead of padding vague articles");
}
if (
  !sourceFiles.codexRunner.content.includes("readerValueChecklist")
  || !sourceFiles.codexRunner.content.includes("fails to answer the title promise")
  || !sourceFiles.codexRunner.content.includes("vague filler article")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent review must reject safe but vague filler articles that do not answer the title");
}
if (!sourceFiles.codexRunner.content.includes("function readerValueChecklistForContract")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Contract must include a reusable reader-value checklist");
}
if (
  !sourceFiles.codexRunner.content.includes("function buildWriterContractRefinementPrompt")
  || !sourceFiles.codexRunner.content.includes("safetyBoundaries")
  || !sourceFiles.codexRunner.content.includes("Do not use token overlap, wording similarity, or phrase matching")
  || !sourceFiles.codexRunner.content.includes("writerContractRefined")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Contract must be semantically refined by an agent before writing");
}
if (
  mainReviewPrompt
  && !mainReviewPrompt.content.includes("speaks about its own writing choices, coverage limits, or validation posture")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent review must reject article-self/meta-writing viewpoint");
}
if (
  writerPrompt
  && (
    !writerPrompt.content.includes("reader-facing subject-state sentences")
    || !writerPrompt.content.includes("not as the default way to state confirmed menus, programs, facts, or conditions")
  )
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must convert source observations into reader-facing subject-state facts");
}
if (
  !sourceFiles.codexRunner.content.includes("Convert source-observation wording into subject-state wording")
  || !sourceFiles.codexRunner.content.includes("what exists, where it belongs, what changes, who is affected")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Contract refinement must semantically convert source-observation wording before writing");
}
if (
  mainReviewPrompt
  && !mainReviewPrompt.content.includes("source-observation or writer-observation statements")
) {
  failed = true;
  console.error("src/lib/codexRunner.js: Main Agent review must reject source-observation viewpoint in reader-facing body");
}
if (!sourceFiles.codexRunner.content.includes("context.preferredTone,\n      researchResult?.writerContract?.tone")) {
  failed = true;
  console.error("src/lib/codexRunner.js: buildWriterContract must prefer user preferredTone over Research/Title tone");
}
if (writerPrompt && !writerPrompt.content.includes("Title image prompts may request short Korean headline text")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must allow short Korean text for title image prompts");
}
if (writerPrompt && !writerPrompt.content.includes("Body image prompts must keep the existing no-text policy")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Writer Agent prompt must keep body images under the existing no-text policy");
}
const imageWorkerPrompt = extractFunctionBlock(sourceFiles.codexRunner, "function buildImageWorkerPrompt", "Image Worker prompt");
if (imageWorkerPrompt && !imageWorkerPrompt.content.includes("Image Worker must not copy image files into the app image directory")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Image Worker must not attempt app-side image copy operations");
}
if (imageWorkerPrompt && imageWorkerPrompt.content.includes("Save generated files inside the Image output directory")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Image Worker prompt must not encourage copying generated images into runtime/image");
}
if (imageWorkerPrompt && !imageWorkerPrompt.content.includes("If image generation returns a concrete existing image file path")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Image Worker must return concrete image paths when available");
}
if (imageWorkerPrompt && !imageWorkerPrompt.content.includes("generated image data is available in the Codex session")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Image Worker prompt must account for base64/data image results");
}
if (imageWorkerPrompt && !imageWorkerPrompt.content.includes("Title image policy:")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Image Worker prompt must separate title image policy");
}
if (imageWorkerPrompt && !imageWorkerPrompt.content.includes("Korean text is allowed in the title image")) {
  failed = true;
  console.error("src/lib/codexRunner.js: title image policy must allow short Korean text");
}
if (imageWorkerPrompt && !imageWorkerPrompt.content.includes("Body image policy:")) {
  failed = true;
  console.error("src/lib/codexRunner.js: Image Worker prompt must keep a separate body image policy");
}
if (imageWorkerPrompt && (
  !imageWorkerPrompt.content.includes("Requested title image aspect ratio")
  || !imageWorkerPrompt.content.includes("Requested body image aspect ratio")
  || !imageWorkerPrompt.content.includes("Generate title images in the requested title image aspect ratio and body images in the requested body image aspect ratio")
)) {
  failed = true;
  console.error("src/lib/codexRunner.js: Image Worker prompt must instruct generation with separate selected title/body aspect ratios");
}
if (sourceFiles.imageAssets.content.includes("function createFallbackTitleImage")) {
  failed = true;
  console.error("src/lib/imageAssets.js: local abstract title-image fallback must not be generated");
}
if (!sourceFiles.imageAssets.content.includes("function recoverCodexSessionImages") || !sourceFiles.imageAssets.content.includes("image_generation_end")) {
  failed = true;
  console.error("src/lib/imageAssets.js: must recover Codex image_generation base64 results from session JSONL");
}
if (!sourceFiles.imageAssets.content.includes("function decodeImageResultPayload")) {
  failed = true;
  console.error("src/lib/imageAssets.js: missing base64/data-url image result decoder");
}
const clickFirstVisible = extractFunctionBlock(sourceFiles.naverPublisher, "async function clickFirstVisible", "clickFirstVisible function");
if (clickFirstVisible && clickFirstVisible.content.includes(".first().waitFor")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: clickFirstVisible must not throw before fallback when no selector is attached");
}
const completeLogin = extractFunctionBlock(sourceFiles.naverPublisher, "async function completeLoginIfNeeded", "completeLoginIfNeeded function");
if (completeLogin && !completeLogin.content.includes("existingMatchesExpectedId")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: prefilled Naver login ID must be compared with the target account ID");
}
if (completeLogin && !completeLogin.content.includes("hasPrefilledCredentials = Boolean(existingId && existingPassword && existingMatchesExpectedId)")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: auto-clicking login must require prefilled ID/PW to match the target account");
}
if (completeLogin && !completeLogin.content.includes("!existingId || hasDifferentPrefilledId")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: mismatched prefilled login ID must be overwritten with the target account ID");
}
if (completeLogin && !completeLogin.content.includes("!existingPassword || hasDifferentPrefilledId")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: mismatched prefilled login ID must force re-entry of the target account password");
}
const titleSelectors = extractFunctionBlock(sourceFiles.naverPublisher, "function titleSelectors", "titleSelectors function");
if (titleSelectors && titleSelectors.content.includes("\"[contenteditable='true']\"")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: titleSelectors must not use generic contenteditable as a title detector");
}
const postWriteWait = extractFunctionBlock(sourceFiles.naverPublisher, "async function waitForPostWriteTitle", "waitForPostWriteTitle function");
if (postWriteWait && !postWriteWait.content.includes("matchesTargetPostWriteUrl(url, postWriteUrl)")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: waitForPostWriteTitle must verify the target postwrite URL before accepting title locator");
}
if (postWriteWait) {
  const postwriteGuardIndex = postWriteWait.content.indexOf("matchesTargetPostWriteUrl(url, postWriteUrl)");
  const draftDialogIndex = postWriteWait.content.indexOf("dismissExistingDraftDialog");
  const editorPopupIndex = postWriteWait.content.indexOf("hasVisibleEditorPopup");
  const titleLocatorIndex = postWriteWait.content.indexOf("findVisibleLocator(page, titleSelectors(selectors)");
  if (postwriteGuardIndex === -1 || titleLocatorIndex === -1 || postwriteGuardIndex > titleLocatorIndex) {
    failed = true;
    console.error("src/lib/naverPublisher.js: waitForPostWriteTitle must check postwrite URL before title locator detection");
  }
  if (
    postwriteGuardIndex === -1
    || draftDialogIndex === -1
    || editorPopupIndex === -1
    || postwriteGuardIndex > draftDialogIndex
    || postwriteGuardIndex > editorPopupIndex
  ) {
    failed = true;
    console.error("src/lib/naverPublisher.js: waitForPostWriteTitle must check postwrite URL before editor popup handling");
  }
}
const articleInsert = extractFunctionBlock(sourceFiles.naverPublisher, "async function insertArticleWithImages", "insertArticleWithImages function");
if (articleInsert && !articleInsert.content.includes("const bodyTypingLog = () => {};")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: sentence-level body typing logs must be suppressed during publishing");
}
if (articleInsert && (!articleInsert.content.includes("본문 글쓰기 시작") || !articleInsert.content.includes("본문 글쓰기 완료"))) {
  failed = true;
  console.error("src/lib/naverPublisher.js: body publishing should log one start and one completion message");
}
if (articleInsert && !articleInsert.content.includes("typeBodyParagraph(page, block.text, options, bodyTypingLog)")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: paragraph typing must use the quiet bodyTypingLog during publishing");
}
const postwriteUrlHelper = extractFunctionBlock(sourceFiles.naverPublisher, "function looksLikePostWriteUrl", "looksLikePostWriteUrl function");
if (postwriteUrlHelper && !postwriteUrlHelper.content.includes("new URL")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: looksLikePostWriteUrl must parse URL instead of using loose substring matching");
}
if (postwriteUrlHelper && !postwriteUrlHelper.content.includes("parsed.hostname === \"blog.naver.com\"")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: looksLikePostWriteUrl must require exact blog.naver.com host");
}
if (postwriteUrlHelper && !postwriteUrlHelper.content.includes("parsed.pathname")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: looksLikePostWriteUrl must validate pathname");
}
const postWriteUrlFor = extractFunctionBlock(sourceFiles.naverPublisher, "function postWriteUrlFor", "postWriteUrlFor function");
if (postWriteUrlFor && !postWriteUrlFor.content.includes("resolveBlogId(options)")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: postwrite URL must use blogId fallback helper");
}
const targetPostwriteHelper = extractFunctionBlock(sourceFiles.naverPublisher, "function matchesTargetPostWriteUrl", "target postwrite URL helper");
if (targetPostwriteHelper && !targetPostwriteHelper.content.includes("normalizePostWriteUrl(url) === normalizePostWriteUrl(targetUrl)")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: target postwrite URL helper must require exact target Blog ID URL");
}
const chromeLaunchOptions = extractFunctionBlock(sourceFiles.naverPublisher, "function chromeLaunchOptions", "Chrome launch options helper");
if (chromeLaunchOptions && !chromeLaunchOptions.content.includes("--hide-crash-restore-bubble")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: Chrome launch options must hide the crash restore bubble");
}
const chromeProfileClean = extractFunctionBlock(sourceFiles.naverPublisher, "function markChromeProfileClean", "Chrome profile clean helper");
if (chromeProfileClean && !chromeProfileClean.content.includes("exit_type = \"Normal\"")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: Chrome profile clean helper must mark profiles as normally exited");
}
if (!sourceFiles.accountStore.content.includes("blogId")) {
  failed = true;
  console.error("src/lib/accountStore.js: account store must preserve optional blogId");
}
if (!sourceFiles.rendererIndex.content.includes("id=\"startupNotice\"")) {
  failed = true;
  console.error("src/renderer/index.html: startup notice must be present for first-run guidance");
}
if (!sourceFiles.rendererApp.content.includes("STARTUP_NOTICE_KEY")) {
  failed = true;
  console.error("src/renderer/app.js: startup notice dismissal must be persisted");
}
if (!sourceFiles.main.content.includes("function detectChromeInstall")) {
  failed = true;
  console.error("src/main.js: app startup must detect whether local Chrome is installed");
}
if (!sourceFiles.main.content.includes("chrome: detectChromeInstall()")) {
  failed = true;
  console.error("src/main.js: initial data must include Chrome availability");
}
if (!sourceFiles.main.content.includes("chrome:installAndQuit")) {
  failed = true;
  console.error("src/main.js: missing Chrome flow must open Chrome install page and quit");
}
if (!sourceFiles.preload.content.includes("openChromeInstallAndQuit")) {
  failed = true;
  console.error("src/preload.js: renderer must be able to trigger Chrome install fallback");
}
if (!sourceFiles.rendererApp.content.includes("state.chrome.available === false")) {
  failed = true;
  console.error("src/renderer/app.js: startup notice confirm must branch when Chrome is missing");
}
if (!sourceFiles.rendererApp.content.includes("data-action=\"session\"")) {
  failed = true;
  console.error("src/renderer/app.js: account rows must expose per-account session check buttons");
}
if (!sourceFiles.rendererIndex.content.includes("<textarea id=\"categoryPublishPurpose\"")) {
  failed = true;
  console.error("src/renderer/index.html: category publish purpose must be a long textarea input");
}
if (!sourceFiles.rendererApp.content.includes("editingCategoryId")) {
  failed = true;
  console.error("src/renderer/app.js: category editing must track the category id being edited");
}
if (!sourceFiles.rendererApp.content.includes("data-action=\"edit\"")) {
  failed = true;
  console.error("src/renderer/app.js: category rows must expose an edit button");
}
if (!sourceFiles.rendererApp.content.includes("function clearCategoryForm")) {
  failed = true;
  console.error("src/renderer/app.js: category manager must be able to reset to new-category mode");
}
if (!sourceFiles.rendererApp.content.includes("const editingId = state.editingCategoryId")) {
  failed = true;
  console.error("src/renderer/app.js: category save must update by edit id instead of only by name");
}
const renderCategoriesBlock = extractFunctionBlock(sourceFiles.rendererApp, "function renderCategories", "renderCategories function");
if (renderCategoriesBlock && renderCategoriesBlock.content.includes("category.publishPurpose")) {
  failed = true;
  console.error("src/renderer/app.js: category publishPurpose must not be displayed in the category list summary");
}
if (
  !sourceFiles.rendererApp.content.includes("function moveCategoryToIndex")
  || !sourceFiles.rendererApp.content.includes("function moveCategoryBefore")
  || !sourceFiles.rendererApp.content.includes("draggable=\"true\"")
  || !sourceFiles.rendererApp.content.includes("data-action=\"move-up\"")
  || !sourceFiles.rendererApp.content.includes("data-action=\"move-down\"")
  || !sourceFiles.rendererStyles.content.includes(".category-row.drag-over")
) {
  failed = true;
  console.error("src/renderer/app.js: category rows must support drag-and-drop and button-based reordering");
}
if (
  !sourceFiles.rendererApp.content.includes("function moveAccountBefore")
  || !sourceFiles.rendererApp.content.includes("account-drag-handle")
  || !sourceFiles.rendererApp.content.includes("draggingAccountId")
  || sourceFiles.rendererApp.content.includes("data-action=\"account-move-up\"")
  || sourceFiles.rendererApp.content.includes("data-action=\"account-move-down\"")
  || !sourceFiles.rendererStyles.content.includes(".account-row.drag-over")
) {
  failed = true;
  console.error("src/renderer/app.js: account rows must support drag-only reordering without up/down buttons");
}
if (sourceFiles.rendererIndex.content.includes("id=\"checkSessionButton\"")) {
  failed = true;
  console.error("src/renderer/index.html: session check should not be hidden inside the collapsed account manager");
}
if (!sourceFiles.rendererApp.content.includes("function wakeAutoDelay")) {
  failed = true;
  console.error("src/renderer/app.js: auto loop must be wakeable after session confirmation");
}
if (!sourceFiles.rendererApp.content.includes("wakeAutoDelay();")) {
  failed = true;
  console.error("src/renderer/app.js: successful session confirmation must wake the auto loop");
}
if (!sourceFiles.main.content.includes("blogId: account.blogId || account.naverId")) {
  failed = true;
  console.error("src/main.js: account session check must use blogId for postwrite URL when present");
}
if (!sourceFiles.main.content.includes("blogId = String(form.blogId || account.blogId || naverId).trim()")) {
  failed = true;
  console.error("src/main.js: job blogId must fall back to naverId when blogId is empty");
}
const insertQuoteBlock = extractFunctionBlock(sourceFiles.naverPublisher, "async function insertQuoteBlock", "insertQuoteBlock function");
if (insertQuoteBlock && /\bthrow\b/.test(insertQuoteBlock.content)) {
  failed = true;
  console.error("src/lib/naverPublisher.js: quote style failure must fall back instead of aborting publish");
}
if (insertQuoteBlock && !insertQuoteBlock.content.includes("일반 문단으로 입력합니다.")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: quote style fallback must continue with normal paragraph input");
}
const insertArticleWithImages = extractFunctionBlock(sourceFiles.naverPublisher, "async function insertArticleWithImages", "insertArticleWithImages function");
const insertSectionHeadingBlock = extractFunctionBlock(sourceFiles.naverPublisher, "async function insertSectionHeadingBlock", "insertSectionHeadingBlock function");
if (!sourceFiles.naverPublisher.content.includes("async function insertSectionHeadingBlock")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: section headings must be parsed from SECTION markers");
}
if (insertSectionHeadingBlock && !insertSectionHeadingBlock.content.includes("\"버티컬 라인\"")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: section headings must use Naver vertical-line quote blocks");
}
if (insertSectionHeadingBlock && !insertSectionHeadingBlock.content.includes("quiet: true")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: repeated section-heading quote logs must be suppressed during body writing");
}
if (insertArticleWithImages && !sourceFiles.naverPublisher.content.includes("\\]?$/i")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: SECTION marker parser must tolerate a missing closing bracket");
}
const clearAiMark = extractFunctionBlock(sourceFiles.naverPublisher, "async function clearAiMarkForLatestImage", "AI image mark helper");
if (clearAiMark && !clearAiMark.content.includes(".se-set-ai-mark-button.se-is-selected")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: AI image mark helper must target selected Naver AI mark toggles");
}
if (clearAiMark && /\bthrow\b/.test(clearAiMark.content)) {
  failed = true;
  console.error("src/lib/naverPublisher.js: AI image mark helper must log and continue instead of throwing");
}
const publishToNaver = extractFunctionBlock(sourceFiles.naverPublisher, "async function publishToNaver", "publishToNaver function");
if (publishToNaver && !publishToNaver.content.includes("발행 단계에서 블로그 글쓰기 URL로 다시 접근했습니다.")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: prepared publish sessions must navigate to postwrite before waiting for editor");
}
if (publishToNaver && !publishToNaver.content.includes("await completeLoginIfNeeded(page, selectors, options, log);")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: prepared publish sessions must re-check login state after navigating to postwrite");
}
if (publishToNaver) {
  const preparedBranchIndex = publishToNaver.content.indexOf("if (options.preparedContext)");
  const preparedGotoIndex = publishToNaver.content.indexOf("발행 단계에서 블로그 글쓰기 URL로 다시 접근했습니다.");
  const editorWaitIndex = publishToNaver.content.indexOf("waitForPostWriteTitle");
  const publishClickIndex = publishToNaver.content.indexOf("clickPublishSettingsButton(page, selectors, log)");
  const publishLayerCheckIndex = publishToNaver.content.indexOf("waitForPublishSettingsLayer(page, selectors, log)");
  if (
    preparedBranchIndex === -1
    || preparedGotoIndex === -1
    || editorWaitIndex === -1
    || !(preparedBranchIndex < preparedGotoIndex && preparedGotoIndex < editorWaitIndex)
  ) {
    failed = true;
    console.error("src/lib/naverPublisher.js: prepared publish sessions must navigate to postwrite before waitForPostWriteTitle");
  }
  if (publishClickIndex === -1 || publishLayerCheckIndex === -1 || !(publishClickIndex < publishLayerCheckIndex)) {
    failed = true;
    console.error("src/lib/naverPublisher.js: publishToNaver must open publish settings via the element-only publish helper and verify the layer");
  }
  if (!publishToNaver.content.includes("clearAiMarkForLatestImage(page, log")) {
    failed = true;
    console.error("src/lib/naverPublisher.js: title image insertion must attempt to clear Naver AI image mark");
  }
}
if (
  sourceFiles.naverPublisher.content.includes("[role='button']:has-text('발행')")
  || sourceFiles.naverPublisher.content.includes("button:text-is('발행')")
  || sourceFiles.naverPublisher.content.includes("button:has(span:text-is('발행'))")
) {
  failed = true;
  console.error("src/lib/naverPublisher.js: publishButton selector must not use broad 발행 text fallbacks");
}

if (insertArticleWithImages && !insertArticleWithImages.content.includes("clearAiMarkForLatestImage(page, log")) {
  failed = true;
  console.error("src/lib/naverPublisher.js: body image insertion must attempt to clear Naver AI image mark");
}

if (failed) {
  process.exit(1);
}

console.log(`Syntax check passed for ${targets.length} JavaScript files.`);
