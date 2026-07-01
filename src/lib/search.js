const http = require("node:http");
const https = require("node:https");

const MAX_RESPONSE_CHARS = 1_500_000;
const MAX_EXCERPT_CHARS = 1400;
const MAX_SELECTED_CONTENT_RESULTS = 20;
const MAX_SEARCH_QUERY_VARIANTS = 4;
const MAX_AUTHORITY_LINK_CANDIDATES = 6;
const CONTENT_FETCH_CONCURRENCY = 4;
const CANDIDATE_FETCH_TIMEOUT_MS = 20000;
const MIN_SELECTED_CANDIDATES_BEFORE_FALLBACK = 5;

const AD_WORDS = [
  "ad",
  "ads",
  "shopping",
  "mall",
  "sponsor",
  "sponsored",
  "파워링크",
  "광고",
  "쇼핑",
  "구매",
  "최저가"
];

const STOP_WORDS = new Set([
  "그리고",
  "그러나",
  "하지만",
  "정보",
  "관련",
  "최신",
  "현재",
  "오늘",
  "기준",
  "확인",
  "방법",
  "안내",
  "바로가기",
  "공식",
  "뉴스",
  "블로그",
  "또는",
  "이내",
  "가능한",
  "정보를",
  "중심으로",
  "있습니다",
  "합니다",
  "서비스",
  "홈페이지",
  "본문",
  "바로",
  "가기",
  "naver",
  "google",
  "www",
  "com",
  "html",
  "https",
  "http"
]);

const CURRENT_FACT_PATTERN = /(모집|채용|접수|신청\s*기간|신청기간|지원\s*대상|지원대상|대상\s*연령|대상연령|신청\s*조건|신청조건|참여\s*대상|참여대상|사업\s*기간|사업기간|운영\s*기간|운영기간|운영\s*시간|영업\s*시간|영업시간|휴무|정기\s*휴무|브레이크\s*타임|라스트\s*오더|예약|주차|가격|요금|입장료|메뉴|전화|주소|위치|판매\s*기간|행사\s*기간|공연\s*일정|업데이트|최신|현재|기준|마감|공고|자격|선발|교육\s*기간|교육기간)/i;
const DATE_FACT_PATTERN = /(20\d{2}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}[./-]\d{1,2}[./-]\d{1,2}|today|yesterday|tomorrow|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;
const LOW_TRUST_DOMAIN_PATTERN = /(blogspot\.com|tistory\.com|wordpress\.com|blog\.naver\.com|m\.blog\.naver\.com|cafe\.naver\.com|brunch\.co\.kr|post\.naver\.com)/i;
const OFFICIAL_DOMAIN_PATTERN = /(^|\.)go\.kr$|(^|\.)gov(\.[a-z]{2,})?$|(^|\.)mil(\.[a-z]{2,})?$|(^|\.)edu(\.[a-z]{2,})?$|(^|\.)ac\.kr$/i;
const INSTITUTIONAL_DOMAIN_PATTERN = /(^|\.)or\.kr$|(^|\.)org$|(^|\.)int$|(^|\.)re\.kr$/i;
const PLATFORM_DOMAIN_PATTERN = /(^|\.)(google|naver|youtube|youtu|facebook|instagram|threads|twitter|x|linkedin|reddit|pinterest|github|medium|velog|notion)\./i;
const UNSUPPORTED_CONTENT_URL_PATTERN = /\.(?:pdf|xls|xlsx|csv|doc|docx|ppt|pptx|hwp|hwpx|zip|7z|rar)(?:[?#].*)?$/i;
const NAVER_BLOG_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={query}";
const NAVER_NEWS_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.news.all&where=news&sm=tab_jum&query={query}";
const NAVER_WEB_SEARCH_URL = "https://search.naver.com/search.naver?where=web&query={query}";

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = /^http:\/\//i.test(url) ? http : https;
    const request = client.get(url, {
      headers: {
        "user-agent": "Mozilla/5.0 NaverBlogAutomator/0.1",
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.7"
      },
      timeout: 12000
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchText(new URL(response.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_RESPONSE_CHARS) {
          request.destroy(new Error("본문이 너무 커서 일부 후보를 건너뜁니다."));
        }
      });
      response.on("end", () => resolve(body));
    });
    request.on("timeout", () => request.destroy(new Error("검색 요청 시간이 초과되었습니다.")));
    request.on("error", reject);
  });
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

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, num) => String.fromCharCode(parseInt(num, 10)));
}

function stripTags(value) {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyAd(text, url) {
  const joined = `${text} ${url}`.toLowerCase();
  return AD_WORDS.some((word) => joined.includes(word.toLowerCase()));
}

function isLowValueResult(text, url) {
  const joined = `${text} ${url}`.toLowerCase();
  const host = hostFromUrl(url);
  if (/검색옵션|검색\s*고객센터|개인정보처리방침|©|naver corp|도움말|고객센터/i.test(text)) {
    return true;
  }
  if (/policy\.naver\.com|help\.naver\.com|www\.navercorp\.com/i.test(url)) {
    return true;
  }
  if (/^support\./i.test(host) || /(^|\.)support\./i.test(host)) {
    return true;
  }
  if (/\b(friend1004|jupiter\d+|apollon\d+|dionysus\d+)\.com\b/i.test(url)) {
    return true;
  }
  if (isUnsupportedContentUrl(url)) {
    return true;
  }
  if (/^keep\.naver\.com$/i.test(host)) {
    return true;
  }
  return /\/privacy|\/policy|\/help|\/support|\/feedback|\/websearch/i.test(joined);
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isUnsupportedContentUrl(url) {
  const normalized = String(url || "").split("#")[0].split("?")[0];
  return UNSUPPORTED_CONTENT_URL_PATTERN.test(normalized);
}

function isOfficialDomain(url) {
  const host = hostFromUrl(url);
  return OFFICIAL_DOMAIN_PATTERN.test(host);
}

function isInstitutionalDomain(url) {
  const host = hostFromUrl(url);
  return INSTITUTIONAL_DOMAIN_PATTERN.test(host);
}

function isLowTrustDomain(url) {
  return LOW_TRUST_DOMAIN_PATTERN.test(hostFromUrl(url));
}

function isPlatformDomain(url) {
  return PLATFORM_DOMAIN_PATTERN.test(hostFromUrl(url));
}

function isTrustedBlogSource(url, profile) {
  if (profile?.trustBlogAsSource !== true) return false;
  return /(^|\.)blog\.naver\.com$|(^|\.)m\.blog\.naver\.com$/i.test(hostFromUrl(url));
}

function isIndependentEditorialSource(url) {
  const host = hostFromUrl(url);
  if (!host) return false;
  if (isOfficialDomain(url) || isInstitutionalDomain(url)) return false;
  if (isLowTrustDomain(url) || isPlatformDomain(url)) return false;
  if (isUnsupportedContentUrl(url)) return false;
  return /\./.test(host);
}

function splitKeywordPhrases(keyword) {
  return String(keyword || "")
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !STOP_WORDS.has(item.toLowerCase()))
    .slice(0, 12);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactTopicForSearch(topic, keyword = "", maxLength = 90) {
  let compacted = String(topic || "")
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
  for (const phrase of splitKeywordPhrases(keyword)) {
    compacted = compacted.replace(new RegExp(escapeRegExp(phrase), "gi"), " ");
  }
  return compacted
    .replace(/[.,;:!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function evidenceText(options) {
  return [
    options.topic,
    options.keyword,
    options.category,
    options.publishPurpose,
    options.researchGuidance,
    normalizeSearchQueries(options.searchQueries).join(" ")
  ].filter(Boolean).join(" ");
}

function requiresStrictSourceEvidence(options) {
  const searchNeed = String(options.searchNeed || "").toLowerCase();
  if (searchNeed !== "strict") return false;
  const text = evidenceText(options);
  return /(모집|채용|접수|신청|공고|지원금|고용지원|취업지원|정책|교육|훈련|대상|자격|마감|기간|공식|현재\s*유효|운영\s*중|신뢰\s*가능)/i.test(text);
}

function requiresAuthoritySourceEvidence(options) {
  if (!requiresStrictSourceEvidence(options)) return false;
  const text = evidenceText(options);
  return /(정책|지원금|정책자금|대출|융자|보조금|공고|신청|접수|모집|채용|고용지원|취업지원|국비|교육|훈련|법령|법률|세금|세무|의료|금융|보험|자격|마감)/i.test(text);
}

function requiresIndependentSourceEvidence(options) {
  if (String(options.searchNeed || "").toLowerCase() !== "strict" || requiresAuthoritySourceEvidence(options)) return false;
  const text = evidenceText(options);
  return /\b(ai|artificial intelligence|llm|agent|gemini|openai|anthropic|claude|google|deepmind|nvidia|intel|amd|microsoft|meta|semiconductor|gpu|chip|model|flash|spark|io|i\/o|computex|roadmap|launch|launched|release|released|announce|announced|announcement|unveil|unveiled|debut|update|updated|earnings|investor|market)\b/i.test(text)
    || /(AI|인공지능|모델|에이전트|반도체|발표|출시|공개|업데이트|로드맵|실적|투자|시장|업계동향)/i.test(text);
}

function buildSearchProfile(options) {
  const independentEvidence = requiresIndependentSourceEvidence(options);
  return {
    strictEvidence: requiresStrictSourceEvidence(options) || independentEvidence,
    authorityEvidence: requiresAuthoritySourceEvidence(options),
    independentEvidence,
    keywordPhrases: splitKeywordPhrases(options.keyword),
    trustBlogAsSource: options.trustBlogAsSource === true
  };
}

function candidateSignals(candidate, profile) {
  const text = `${candidate.title || ""} ${candidate.excerpt || ""}`;
  const lower = text.toLowerCase();
  const phraseMatches = profile.keywordPhrases
    .filter((phrase) => lower.includes(phrase.toLowerCase()))
    .slice(0, 10);
  const blogTrustedSource = profile.strictEvidence && isTrustedBlogSource(candidate.url, profile);
  return {
    officialSource: profile.strictEvidence && isOfficialDomain(candidate.url),
    institutionalSource: profile.strictEvidence && isInstitutionalDomain(candidate.url),
    independentSource: profile.strictEvidence && isIndependentEditorialSource(candidate.url),
    blogTrustedSource,
    lowTrustSource: profile.strictEvidence && isLowTrustDomain(candidate.url) && !blogTrustedSource,
    currentFactSignal: profile.strictEvidence && (CURRENT_FACT_PATTERN.test(text) || DATE_FACT_PATTERN.test(text)),
    phraseMatches
  };
}

function parseLinks(html, provider) {
  const results = [];
  const seen = new Set();
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) && results.length < 40) {
    let url = match[1];
    const title = stripTags(match[2]);
    if (!title || title.length < 6) continue;
    if (provider === "google" && url.startsWith("/url?")) {
      const parsed = new URL(url, "https://www.google.com");
      url = parsed.searchParams.get("q") || "";
    }
    if (provider === "naver" && url.startsWith("/")) {
      url = new URL(url, "https://search.naver.com").toString();
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (isLikelyAd(title, url)) continue;
    if (isLowValueResult(title, url)) continue;
    const key = url.replace(/[#?].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ provider, title, url });
  }
  return results;
}

function normalizeOutboundUrl(rawUrl, baseUrl = "") {
  try {
    let url = new URL(decodeEntities(rawUrl), baseUrl || "https://search.naver.com").toString();
    const parsed = new URL(url);
    const nested = parsed.searchParams.get("url")
      || parsed.searchParams.get("u")
      || parsed.searchParams.get("target")
      || parsed.searchParams.get("to");
    if (nested && /^https?:\/\//i.test(nested)) {
      url = decodeEntities(nested);
    }
    return /^https?:\/\//i.test(url) ? url : "";
  } catch {
    return "";
  }
}

function extractAuthorityLinks(html, baseUrl = "") {
  const results = [];
  const seen = new Set();
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(String(html || ""))) && results.length < MAX_AUTHORITY_LINK_CANDIDATES) {
    const url = normalizeOutboundUrl(match[1], baseUrl);
    if (!url) continue;
    if (!isOfficialDomain(url) && !isInstitutionalDomain(url)) continue;
    if (isLowValueResult("", url) || isUnsupportedContentUrl(url)) continue;
    const key = url.replace(/[#?].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const title = stripTags(match[2]) || hostFromUrl(url);
    results.push({ provider: "source-link", title, url });
  }
  return results;
}

function candidateMatchesSearchIntent(candidate, options) {
  const searchText = `${candidate.title || ""} ${candidate.url || ""}`.toLowerCase();
  const keywordTokens = tokenize(options.keyword || "");
  const topicTokens = tokenize(compactTopicForSearch(options.topic || "", options.keyword || ""));
  const queryTokens = tokenize(normalizeSearchQueries(options.searchQueries).join(" "));
  const requiredTokens = uniqueStrings([...keywordTokens, ...topicTokens, ...queryTokens])
    .filter((token) => token.length > 2 || /[0-9]/.test(token))
    .slice(0, 16);
  if (!requiredTokens.length) return true;
  return requiredTokens.some((token) => searchText.includes(token.toLowerCase()));
}

function findNaverBlogFrame(html, url) {
  if (!/blog\.naver\.com/i.test(url)) return "";
  const match = String(html || "").match(/<iframe[^>]+(?:id|name)=["']?mainFrame["']?[^>]+src=["']([^"']+)["']/i)
    || String(html || "").match(/<iframe[^>]+src=["']([^"']*PostView[^"']+)["']/i);
  if (!match) return "";
  return new URL(decodeEntities(match[1]), "https://blog.naver.com").toString();
}

function mobileNaverBlogUrl(url) {
  const match = String(url || "").match(/^https?:\/\/blog\.naver\.com\/([^/?#]+)\/(\d+)/i);
  if (!match) return "";
  return `https://m.blog.naver.com/${match[1]}/${match[2]}`;
}

function extractMetaDescription(html) {
  const match = String(html || "").match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)
    || String(html || "").match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i);
  return match ? stripTags(match[1]) : "";
}

function extractReadableText(html) {
  const withoutNoise = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(header|footer|nav|aside)\b[\s\S]*?<\/\1>/gi, " ");

  const preferredBlocks = [];
  const preferredRegex = /<(article|main|section|div|p)\b[^>]*(?:se-main-container|se_component_wrap|post_ct|post-view|article|content|entry|본문|view|post)[^>]*>([\s\S]*?)<\/\1>/gi;
  let block;
  while ((block = preferredRegex.exec(withoutNoise)) && preferredBlocks.length < 8) {
    const text = stripTags(block[2]);
    if (text.length > 120) preferredBlocks.push(text);
  }

  const text = preferredBlocks.length
    ? preferredBlocks.join("\n")
    : stripTags(withoutNoise);
  return text
    .replace(/\s*(공감|댓글|스크랩|공유하기|이 블로그|카테고리 글)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const text = String(value || "").toLowerCase();
  const tokens = text.match(/[가-힣a-z0-9]{2,}/g) || [];
  return tokens
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
    .slice(0, 80);
}

function tokenCounts(items) {
  const counts = new Map();
  for (const item of items) {
    for (const token of new Set(tokenize(item))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return counts;
}

function selectCommonTokens(candidates, options) {
  const counts = tokenCounts(candidates.map((item) => `${item.title} ${item.excerpt || ""}`));
  const topicTokens = new Set(tokenize(options.topic || ""));
  const keywordTokens = new Set(tokenize(options.keyword || ""));
  return [...counts.entries()]
    .map(([token, count]) => ({
      token,
      score: count + (topicTokens.has(token) ? 4 : 0) + (keywordTokens.has(token) ? 1 : 0)
    }))
    .filter((item) => item.score >= 2 || topicTokens.has(item.token) || keywordTokens.has(item.token))
    .sort((a, b) => b.score - a.score)
    .slice(0, 16)
    .map((item) => item.token);
}

function scoreCandidate(candidate, commonTokens, options, profile = buildSearchProfile(options)) {
  const textTokens = new Set(tokenize(`${candidate.title} ${candidate.excerpt || ""}`));
  const topicTokens = new Set(tokenize(options.topic || ""));
  const keywordTokens = new Set(tokenize([
    options.keyword || "",
    normalizeSearchQueries(options.searchQueries).join(" ")
  ].filter(Boolean).join(" ")));
  const signals = candidateSignals(candidate, profile);
  let score = 0;
  const matchedTerms = [];
  const topicMatchedTerms = [];
  const keywordMatchedTerms = [];

  for (const token of commonTokens) {
    if (textTokens.has(token)) {
      score += 1;
      matchedTerms.push(token);
    }
  }
  for (const token of topicTokens) {
    if (textTokens.has(token)) {
      score += 6;
      if (!matchedTerms.includes(token)) matchedTerms.push(token);
      topicMatchedTerms.push(token);
    }
  }
  for (const token of keywordTokens) {
    if (textTokens.has(token)) {
      score += 1;
      if (!matchedTerms.includes(token)) matchedTerms.push(token);
      keywordMatchedTerms.push(token);
    }
  }
  for (const phrase of signals.phraseMatches) {
    score += 4;
    if (!matchedTerms.includes(phrase)) matchedTerms.push(phrase);
    if (!keywordMatchedTerms.includes(phrase)) keywordMatchedTerms.push(phrase);
  }
  if (signals.officialSource) score += 5;
  if (signals.institutionalSource) score += 3;
  if (signals.independentSource) score += 3;
  if (signals.blogTrustedSource) score += 2;
  if (signals.currentFactSignal) score += 4;
  if (signals.lowTrustSource) score -= 4;
  if ((candidate.excerpt || "").length > 180) score += 2;
  return {
    score,
    matchedTerms: matchedTerms.slice(0, 10),
    topicMatchedTerms: topicMatchedTerms.slice(0, 10),
    keywordMatchedTerms: keywordMatchedTerms.slice(0, 10),
    officialSource: signals.officialSource,
    institutionalSource: signals.institutionalSource,
    independentSource: signals.independentSource,
    blogTrustedSource: signals.blogTrustedSource,
    lowTrustSource: signals.lowTrustSource,
    currentFactSignal: signals.currentFactSignal,
    strictEvidence: profile.strictEvidence,
    authorityEvidence: profile.authorityEvidence,
    independentEvidence: profile.independentEvidence
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchCandidateContent(candidate) {
  const attempts = [candidate.url];
  const mobileUrl = mobileNaverBlogUrl(candidate.url);
  if (mobileUrl) attempts.push(mobileUrl);
  const outboundLinks = [];

  for (const attemptUrl of attempts) {
    try {
      let html = await withTimeout(
        fetchText(attemptUrl),
        CANDIDATE_FETCH_TIMEOUT_MS,
        "본문 추출 후보 요청 시간이 초과되었습니다."
      );
      outboundLinks.push(...extractAuthorityLinks(html, attemptUrl));
      const frameUrl = findNaverBlogFrame(html, attemptUrl);
      if (frameUrl) {
        html = await withTimeout(
          fetchText(frameUrl),
          CANDIDATE_FETCH_TIMEOUT_MS,
          "네이버 블로그 본문 프레임 요청 시간이 초과되었습니다."
        );
        outboundLinks.push(...extractAuthorityLinks(html, frameUrl));
      }
      const description = extractMetaDescription(html);
      const readable = extractReadableText(html);
      const text = readable.length >= 160 ? readable : description;
      if (text && text.length >= 80) {
        return {
          ...candidate,
          fetchedUrl: attemptUrl,
          contentLength: text.length,
          excerpt: text.slice(0, MAX_EXCERPT_CHARS),
          outboundLinks: uniqueCandidates(outboundLinks).slice(0, MAX_AUTHORITY_LINK_CANDIDATES)
        };
      }
    } catch {
      // Try the next URL form.
    }
  }

  return {
    ...candidate,
    fetchedUrl: "",
    contentLength: 0,
    excerpt: "",
    outboundLinks: uniqueCandidates(outboundLinks).slice(0, MAX_AUTHORITY_LINK_CANDIDATES)
  };
}

function uniqueCandidates(items) {
  const seen = new Set();
  const output = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item?.url || "").replace(/[#?].*$/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function mergeCandidateLists(priorityItems, existingItems, limit = 20) {
  return uniqueCandidates([...(priorityItems || []), ...(existingItems || [])]).slice(0, limit);
}

function isAuthorityCandidate(item) {
  return isOfficialDomain(item?.url) || isInstitutionalDomain(item?.url);
}

function isPrioritySourceCandidate(item, profile) {
  if (!profile?.strictEvidence) return false;
  if (isAuthorityCandidate(item)) return true;
  return profile.independentEvidence === true && isIndependentEditorialSource(item?.url);
}

function buildCandidateFetchList(items, profile, limit = 20) {
  const unique = uniqueCandidates(items);
  if (!profile?.strictEvidence) return unique.slice(0, limit);
  const priority = unique.filter((item) => isPrioritySourceCandidate(item, profile));
  return mergeCandidateLists(priority, unique, limit);
}

function normalizeSearchChannel(value) {
  return ["blog", "news", "web"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "blog";
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizeSearchQueries(searchQueries) {
  const rawQueries = Array.isArray(searchQueries)
    ? searchQueries
    : String(searchQueries || "").split(/\n+/);
  return uniqueStrings(rawQueries)
    .filter((query) => query.length >= 3)
    .map((query) => query.slice(0, 140).trim())
    .slice(0, MAX_SEARCH_QUERY_VARIANTS);
}

function naverSearchTemplateFor(options = {}) {
  const channel = normalizeSearchChannel(options.searchChannel);
  if (channel === "news") return NAVER_NEWS_SEARCH_URL;
  if (channel === "web") return NAVER_WEB_SEARCH_URL;
  return NAVER_BLOG_SEARCH_URL;
}

function buildSearchUrl(provider, template, topic, keyword, topicMode, querySuffix = "", queryOverride = "") {
  const queryText = queryOverride
    ? [String(queryOverride || "").replace(/\s+/g, " ").trim(), querySuffix]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260)
    : buildQueryText(topic, keyword, topicMode, querySuffix);
  const query = encodeURIComponent(queryText);
  if (template && template.includes("{query}")) {
    return template.replace("{query}", query);
  }
  if (provider === "naver") {
    return `https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query=${query}`;
  }
  return `https://www.google.com/search?q=${query}&num=20&hl=ko`;
}

async function providerSearch(provider, options, querySuffix = "", queryOverride = "") {
  const template = provider === "naver" ? naverSearchTemplateFor(options) : options.googleSearchUrl;
  const url = buildSearchUrl(
    provider,
    template,
    options.topic,
    options.keyword,
    options.topicMode,
    querySuffix,
    queryOverride
  );
  const html = await fetchText(url);
  return parseLinks(html, provider);
}

function isStrongCandidate(item, profile) {
  if (!profile.strictEvidence) return Number(item?.relevance?.score || 0) >= 3;
  const relevance = item.relevance || {};
  const hasDirectKeyword = Array.isArray(relevance.keywordMatchedTerms) && relevance.keywordMatchedTerms.length > 0;
  const hasAuthoritySource = relevance.officialSource === true || relevance.institutionalSource === true;
  const hasIndependentSource = relevance.independentSource === true;
  const hasReliableSource = profile.authorityEvidence
    ? hasAuthoritySource
    : profile.independentEvidence
      ? hasAuthoritySource || hasIndependentSource
      : hasAuthoritySource || relevance.blogTrustedSource === true || relevance.lowTrustSource !== true;
  return hasReliableSource
    && relevance.currentFactSignal === true
    && hasDirectKeyword
    && Number(relevance.score || 0) >= 8;
}

function selectAuthorityClues(items, options) {
  const text = [
    options.topic,
    options.keyword,
    options.publishPurpose,
    options.researchGuidance,
    normalizeSearchQueries(options.searchQueries).join(" "),
    ...items.slice(0, 5).flatMap((item) => [item?.title, item?.excerpt])
  ].filter(Boolean).join(" ");
  const priority = [
    ...(String(text).match(/20\d{2}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|20\d{2}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일/g) || []),
    ...(String(text).match(/[가-힣A-Za-z0-9]+(?:부|청|처|공단|공사|진흥원|위원회|센터|재단|협회|소상공인24|고용24|기업마당)/g) || []),
    ...(String(text).match(/[가-힣A-Za-z0-9]+(?:지원사업|정책자금|직접대출|공고|모집|사업|제도|법|Act)/g) || [])
  ];
  return uniqueStrings(priority)
    .filter((item) => item.length >= 3)
    .slice(0, 8)
    .join(" ");
}

function selectEvidenceSearchTerms(options, items = []) {
  const text = [
    options.topic,
    options.keyword,
    options.category,
    options.publishPurpose,
    options.researchGuidance,
    normalizeSearchQueries(options.searchQueries).join(" "),
    ...items.slice(0, 5).flatMap((item) => [item?.title, item?.excerpt])
  ].filter(Boolean).join(" ");
  const groups = [
    {
      pattern: /(신청|접수|모집|채용|지원금|지원\s*대상|지원\s*조건|정책\s*자금|대출|보조금|자격|마감|공고)/i,
      terms: ["공식 공고", "신청 조건", "대상 자격", "접수 기간"]
    },
    {
      pattern: /(공시|계약|수주|공급계약|IR|investor|투자자|실적|잠정실적|매출|영업이익|배당|자사주)/i,
      terms: ["공시", "IR", "투자자 자료", "계약 원문"]
    },
    {
      pattern: /(보고서|전망|지표|지수|통계|데이터|등급|신용평가|산업\s*전망|수주잔고|선가|시장\s*자료)/i,
      terms: ["보고서", "지표", "통계", "원문", "PDF"]
    },
    {
      pattern: /(발표|출시|공개|업데이트|로드맵|제품|모델|기술|launch|release|announcement|unveil)/i,
      terms: ["공식 발표", "뉴스룸", "자료", "원문"]
    },
    {
      pattern: /(법령|법률|규제|세금|세무|의료|보험|허가|인증)/i,
      terms: ["법령", "고시", "기관 원문", "PDF"]
    }
  ];
  const terms = [];
  for (const group of groups) {
    if (group.pattern.test(text)) {
      terms.push(...group.terms);
    }
  }
  if (/PDF|원문|공식|기관|자료/i.test(text)) {
    terms.push("공식 자료", "원문", "PDF");
  }
  return uniqueStrings(terms.length ? terms : ["공식 자료", "원문", "보고서", "PDF"])
    .slice(0, 8)
    .join(" ");
}

function focusedOfficialSearchSuffix(options, profile, items = []) {
  if (!profile.strictEvidence) return "";
  const phrases = profile.keywordPhrases.slice(0, 4).join(" ");
  const topic = String(options.topic || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const clues = selectAuthorityClues(items, options);
  const evidenceTerms = selectEvidenceSearchTerms(options, items);
  return [clues, topic, phrases, evidenceTerms]
    .filter(Boolean)
    .join(" ")
    .slice(0, 220);
}

function focusedIndependentSearchSuffix(options, profile, items = []) {
  if (!profile.strictEvidence || !profile.independentEvidence) return "";
  const phrases = profile.keywordPhrases.slice(0, 4).join(" ");
  const topic = String(options.topic || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const clues = selectAuthorityClues(items, options);
  return [clues, topic, phrases, "news report coverage analysis launch release announced"]
    .filter(Boolean)
    .join(" ")
    .slice(0, 220);
}

function compactKeywordQuery(keyword, maxPhrases = 6) {
  return splitKeywordPhrases(keyword).slice(0, maxPhrases).join(" ");
}

function buildQueryText(topic, keyword, topicMode, querySuffix = "") {
  const cleanedTopic = String(topic || "").replace(/\s+/g, " ").trim();
  const keywordText = compactKeywordQuery(keyword, String(topicMode || "manual") === "auto" ? 6 : 4);
  const isAuto = String(topicMode || "manual") === "auto";
  const topicText = isAuto
    ? compactTopicForSearch(cleanedTopic, keyword, keywordText ? 55 : 140)
    : cleanedTopic.slice(0, 140);
  const base = (isAuto ? [keywordText, topicText] : [topicText, keywordText])
    .filter(Boolean)
    .join(" ")
    .slice(0, 180);
  return [base, querySuffix]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

async function collectProviderCandidates(providers, options, log, querySuffix = "", control = {}) {
  const all = [];
  for (const provider of providers) {
    if (!["naver", "google"].includes(provider)) continue;
    if (control.attemptedProviders instanceof Set) {
      control.attemptedProviders.add(provider);
    }
    try {
      log(`${provider.toUpperCase()} 검색을 시도합니다.`);
      const optionVariants = provider === "naver" && control.includeNaverWebFallback === true
        ? [options, { ...options, searchChannel: "web" }]
        : [options];
      for (const optionVariant of optionVariants) {
        const results = await providerSearch(
          provider,
          optionVariant,
          querySuffix,
          control.queryOverride || ""
        );
        all.push(...results);
      }
    } catch (error) {
      log(`${provider.toUpperCase()} 검색 실패: ${error.message}`);
    }
    if (all.length >= 20 && control.forceAllProviders !== true) break;
  }
  return all;
}

function shouldRunFallbackForSparseSelection(selected, attemptedProviders, primary, fallback, profile) {
  if (profile.strictEvidence) return false;
  if (!["naver", "google"].includes(fallback)) return false;
  if (fallback === primary) return false;
  if (attemptedProviders instanceof Set && attemptedProviders.has(fallback)) return false;
  return (Array.isArray(selected) ? selected.length : 0) < MIN_SELECTED_CANDIDATES_BEFORE_FALLBACK;
}

async function collectSearchResults(options, log = () => {}) {
  const primary = String(options.primaryProvider || "naver").toLowerCase();
  const fallback = String(options.fallbackProvider || "google").toLowerCase();
  const providers = [primary, fallback];
  const profile = buildSearchProfile(options);
  const queryVariants = normalizeSearchQueries(options.searchQueries);
  const attemptedProviders = new Set();
  const providerControl = {
    forceAllProviders: profile.strictEvidence,
    includeNaverWebFallback: profile.strictEvidence && normalizeSearchChannel(options.searchChannel) !== "web",
    attemptedProviders
  };
  const collectRawCandidates = async (querySuffix = "", providerList = providers, control = providerControl) => {
    if (!queryVariants.length) {
      return collectProviderCandidates(providerList, options, log, querySuffix, control);
    }
    const collected = [];
    for (const query of queryVariants) {
      log(`Narrow search query: ${query}`);
      const queryResults = await collectProviderCandidates(
        providerList,
        options,
        log,
        querySuffix,
        { ...control, queryOverride: query }
      );
      collected.push(...queryResults);
    }
    return collected;
  };
  let all = await collectRawCandidates();

  const buildFilteredCandidates = (items) => {
    const seen = new Set();
    const filtered = items
      .filter((item) => {
        const key = item.url.replace(/[#?].*$/, "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .filter((item) => !isLowValueResult(item.title, item.url))
      .filter((item) => candidateMatchesSearchIntent(item, options));
    return buildCandidateFetchList(filtered, profile, 20);
  };
  let candidates = buildFilteredCandidates(all);

  if (!candidates.length && shouldRunFallbackForSparseSelection([], attemptedProviders, primary, fallback, profile)) {
    log(`Selected source candidates below ${MIN_SELECTED_CANDIDATES_BEFORE_FALLBACK}; running fallback provider once: ${fallback.toUpperCase()}`);
    const fallbackResults = await collectRawCandidates("", [fallback], { ...providerControl, forceAllProviders: true });
    all = [...all, ...fallbackResults];
    candidates = buildFilteredCandidates(all);
  }

  if (!candidates.length) return [];

  const enrichAndScore = async (items) => {
    log(`검색 후보 ${items.length}개 본문 추출을 시도합니다.`);
    let completed = 0;
    const enriched = await mapLimit(
      items,
      CONTENT_FETCH_CONCURRENCY,
      async (candidate) => {
        const result = await fetchCandidateContent(candidate);
        completed += 1;
        if (completed === 1 || completed % 2 === 0 || completed === items.length) {
          log(`본문 추출 진행: ${completed}/${items.length}`);
        }
        return result;
      }
    );
    const validEnriched = enriched.filter(Boolean);
    const withContent = validEnriched.filter((item) => String(item.excerpt || "").trim().length >= 80);
    if (!withContent.length) return { selected: [], withContent: [] };
    const commonTokens = selectCommonTokens(withContent, options);
    const scoredAll = withContent.map((item) => {
      const relevance = scoreCandidate(item, commonTokens, options, profile);
      return { ...item, relevance };
    });
    const eligible = scoredAll.filter((item) => {
      const hasTopicTokens = tokenize(options.topic || "").length > 0;
      const hasTopicMatch = Array.isArray(item.relevance.topicMatchedTerms) && item.relevance.topicMatchedTerms.length > 0;
      const hasKeywordMatch = Array.isArray(item.relevance.keywordMatchedTerms) && item.relevance.keywordMatchedTerms.length > 0;
      const priorityEvidence = isPrioritySourceCandidate(item, profile) && (hasTopicMatch || hasKeywordMatch);
      return item.relevance.score >= 3 && ((!hasTopicTokens || hasTopicMatch) || priorityEvidence);
    });
    const sorted = eligible.sort((a, b) => b.relevance.score - a.relevance.score);
    const priorityEvidence = sorted.filter((item) => isPrioritySourceCandidate(item, profile));
    const scored = profile.strictEvidence
      ? mergeCandidateLists(priorityEvidence, sorted, MAX_SELECTED_CONTENT_RESULTS)
      : sorted.slice(0, MAX_SELECTED_CONTENT_RESULTS);

    return { selected: scored, withContent };
  };

  let { selected, withContent } = await enrichAndScore(candidates);
  if (shouldRunFallbackForSparseSelection(selected, attemptedProviders, primary, fallback, profile)) {
    log(`Selected source candidates below ${MIN_SELECTED_CANDIDATES_BEFORE_FALLBACK}; running fallback provider once: ${fallback.toUpperCase()}`);
    const fallbackResults = await collectRawCandidates("", [fallback], { ...providerControl, forceAllProviders: true });
    all = [...all, ...fallbackResults];
    candidates = buildFilteredCandidates(all);
    ({ selected, withContent } = await enrichAndScore(candidates));
  }
  if (profile.authorityEvidence && !selected.some((item) => isStrongCandidate(item, profile))) {
    const authorityLinkCandidates = uniqueCandidates((selected.length ? selected : withContent)
      .flatMap((item) => Array.isArray(item?.outboundLinks) ? item.outboundLinks : []))
      .slice(0, MAX_AUTHORITY_LINK_CANDIDATES);
    if (authorityLinkCandidates.length) {
      log(`블로그 본문에 명시된 공식/기관 출처 ${authorityLinkCandidates.length}개를 보강 후보로 확인합니다.`, "info");
      candidates = mergeCandidateLists(authorityLinkCandidates, candidates, 20);
      ({ selected, withContent } = await enrichAndScore(candidates));
    } else {
      log("블로그 본문에서 직접 공식 링크를 찾지 못해 기관명/사업명 단서로 공식사이트를 재검색합니다.", "info");
    }
  }
  if (profile.strictEvidence && !selected.some((item) => isStrongCandidate(item, profile))) {
    const suffix = profile.independentEvidence
      ? focusedIndependentSearchSuffix(options, profile, selected.length ? selected : withContent)
      : focusedOfficialSearchSuffix(options, profile, selected.length ? selected : withContent);
    if (suffix) {
      log(profile.authorityEvidence
        ? "공식/기관 근거가 필요한 검색으로 판단되어 공식사이트 보강 검색을 실행합니다."
        : profile.independentEvidence
          ? "독립 신뢰 근거가 필요한 검색으로 판단되어 넓은 웹 보강 검색을 실행합니다."
          : "현재성/신뢰 근거가 필요한 검색으로 판단되어 보강 검색합니다.", "info");
      const refined = await collectRawCandidates(suffix);
      const authorityRefined = refined.filter((item) => isOfficialDomain(item.url) || isInstitutionalDomain(item.url));
      const independentRefined = refined.filter((item) => isIndependentEditorialSource(item.url));
      candidates = mergeCandidateLists([...authorityRefined, ...independentRefined, ...refined], candidates, 20);
      ({ selected, withContent } = await enrichAndScore(candidates));
    }
  }

  if (!withContent.length) {
    log("본문 추출에 성공한 후보가 없어 제목/URL 후보만 사용합니다.", "warn");
    return candidates;
  }
  log(`본문 추출 ${withContent.length}개, 공통 주제 후보 ${selected.length}개를 사용합니다.`);
  return selected.map((item, index) => ({
    sourceId: `${item.provider || "source"}-${index + 1}`,
    provider: item.provider,
    title: item.title,
    url: item.url,
    fetchedUrl: item.fetchedUrl,
    contentLength: item.contentLength,
    excerpt: item.excerpt,
    outboundLinks: Array.isArray(item.outboundLinks) ? item.outboundLinks : [],
    relevance: item.relevance || { score: 0, matchedTerms: [] }
  }));
}

function hasDirectRelevance(item) {
  const relevance = item?.relevance || {};
  const score = Number(relevance.score || 0);
  const matchedCount = [
    ...(Array.isArray(relevance.topicMatchedTerms) ? relevance.topicMatchedTerms : []),
    ...(Array.isArray(relevance.keywordMatchedTerms) ? relevance.keywordMatchedTerms : []),
    ...(Array.isArray(relevance.matchedTerms) ? relevance.matchedTerms : [])
  ].length;
  return score >= 3 && matchedCount > 0;
}

function hasStrongEvidence(item) {
  const relevance = item?.relevance || {};
  const hasDirectKeyword = Array.isArray(relevance.keywordMatchedTerms) && relevance.keywordMatchedTerms.length > 0;
  const hasAuthoritySource = relevance.officialSource === true || relevance.institutionalSource === true;
  const hasIndependentSource = relevance.independentSource === true;
  const hasReliableSource = relevance.authorityEvidence === true
    ? hasAuthoritySource
    : relevance.independentEvidence === true
      ? hasAuthoritySource || hasIndependentSource
      : hasAuthoritySource || relevance.blogTrustedSource === true || relevance.lowTrustSource !== true;
  return relevance.strictEvidence === true
    && hasReliableSource
    && relevance.currentFactSignal === true
    && hasDirectKeyword
    && Number(relevance.score || 0) >= 8;
}

function summarizeSourceQuality(searchResults, _topicMode = "manual", options = {}) {
  const results = Array.isArray(searchResults) ? searchResults : [];
  const withExcerpt = results.filter((item) => String(item?.excerpt || "").trim().length >= 80);
  const usable = results.filter((item) => {
    const excerptLength = String(item?.excerpt || "").trim().length;
    const contentLength = Number(item?.contentLength || 0);
    return excerptLength >= 120 || contentLength >= 300;
  });
  const directlyRelevant = results.filter(hasDirectRelevance);
  const topicMatched = results.filter((item) => Array.isArray(item?.relevance?.topicMatchedTerms) && item.relevance.topicMatchedTerms.length);
  const strongEvidence = results.filter(hasStrongEvidence);
  const authorityEvidence = results.filter((item) => item?.relevance?.officialSource === true || item?.relevance?.institutionalSource === true);
  const independentEvidence = results.filter((item) => item?.relevance?.independentSource === true);
  const trustedBlogDiscovery = results.filter((item) => item?.relevance?.blogTrustedSource === true);
  const strictEvidence = String(options.searchNeed || "").toLowerCase() === "strict"
    && results.some((item) => item?.relevance?.strictEvidence === true);
  const authorityRequired = strictEvidence && results.some((item) => item?.relevance?.authorityEvidence === true);
  const independentRequired = strictEvidence && results.some((item) => item?.relevance?.independentEvidence === true);
  const usableRelevant = usable.filter(hasDirectRelevance);
  const status = strictEvidence
    ? strongEvidence.length ? "usable" : "insufficient"
    : usableRelevant.length ? "usable" : "insufficient";
  const compactSource = (item, index) => ({
    sourceId: String(item?.sourceId || `source-${index + 1}`),
    provider: String(item?.provider || ""),
    title: String(item?.title || ""),
    url: String(item?.url || ""),
    score: Number(item?.relevance?.score || 0),
    officialSource: item?.relevance?.officialSource === true,
    institutionalSource: item?.relevance?.institutionalSource === true,
    independentSource: item?.relevance?.independentSource === true
  });
  return {
    status,
    totalCandidates: results.length,
    extractedCandidates: withExcerpt.length,
    usableExtractedCandidates: usable.length,
    directlyRelevantCandidates: directlyRelevant.length,
    topicMatchedCandidates: topicMatched.length,
    strongEvidenceCandidates: strongEvidence.length,
    authorityEvidenceRequired: authorityRequired,
    authorityEvidenceCandidates: authorityEvidence.length,
    authorityEvidenceSources: authorityEvidence.slice(0, 6).map(compactSource),
    independentEvidenceRequired: independentRequired,
    independentEvidenceCandidates: independentEvidence.length,
    independentEvidenceSources: independentEvidence.slice(0, 6).map(compactSource),
    trustedBlogDiscoveryCandidates: trustedBlogDiscovery.length,
    reason: status === "usable"
      ? strictEvidence
        ? authorityRequired
          ? "검색 후보에서 공식/기관 근거와 주제 직접성이 함께 확인되었습니다."
          : independentRequired
            ? "검색 후보에서 독립 신뢰 근거와 주제 직접성이 함께 확인되었습니다."
          : "검색 후보에서 현재성/신뢰 근거와 주제 직접성이 함께 확인되었습니다."
        : "검색 후보에서 주제와 직접 관련된 본문 발췌가 확보되었습니다."
      : strictEvidence
        ? authorityRequired && trustedBlogDiscovery.length
          ? "블로그 후보는 주제 단서로 확인되었지만 공식/기관 근거가 부족합니다. 블로그에 명시된 기관명·사업명·공고명을 바탕으로 공식 원문 보강 검색이 필요합니다."
          : independentRequired && trustedBlogDiscovery.length
            ? "블로그 후보는 주제 단서로 확인되었지만 독립 신뢰 근거가 부족합니다. 공식 원문 또는 독립 편집 매체 보강 검색이 필요합니다."
          : "신뢰 가능한 현재성 근거와 주제 직접성이 함께 확인되는 검색 후보가 부족합니다."
        : "검색 후보에서 주제와 직접 관련된 본문 발췌가 부족합니다. 주제/키워드 오타 또는 검색 결과 불일치 가능성이 있습니다."
  };
}

module.exports = {
  collectSearchResults,
  summarizeSourceQuality,
  _private: {
    naverSearchTemplateFor,
    buildQueryText,
    buildSearchProfile,
    scoreCandidate,
    summarizeSourceQuality,
    isLowValueResult,
    isUnsupportedContentUrl,
    compactTopicForSearch,
    normalizeSearchQueries,
    requiresAuthoritySourceEvidence,
    requiresIndependentSourceEvidence,
    isIndependentEditorialSource,
    selectAuthorityClues,
    selectEvidenceSearchTerms,
    extractAuthorityLinks,
    mergeCandidateLists,
    buildCandidateFetchList,
    candidateMatchesSearchIntent,
    isStrongCandidate,
    hasDirectRelevance,
    hasStrongEvidence
  }
};
