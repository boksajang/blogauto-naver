const fs = require("node:fs");
const path = require("node:path");

function ensureRuntimeFiles(runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "image"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "jobs"), { recursive: true });
  const historyPath = path.join(runtimeRoot, "blog_history.jsonl");
  if (!fs.existsSync(historyPath)) {
    fs.writeFileSync(historyPath, "", "utf8");
  }
}

function getHistoryPath(runtimeRoot) {
  ensureRuntimeFiles(runtimeRoot);
  return path.join(runtimeRoot, "blog_history.jsonl");
}

function readHistory(runtimeRoot) {
  const historyPath = getHistoryPath(runtimeRoot);
  const text = fs.readFileSync(historyPath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return {
          id: `invalid_${Date.now()}`,
          create_at: "",
          account_id: "",
          blog_id: "",
          title: "",
          topic: "",
          keyword: "",
          status: "failed",
          embedding_model: "",
          embedding: [],
          reason: "blog_history.jsonl 행을 읽을 수 없습니다."
        };
      }
    })
    .sort((a, b) => String(b.create_at || "").localeCompare(String(a.create_at || "")));
}

function appendHistory(runtimeRoot, entry) {
  const historyPath = getHistoryPath(runtimeRoot);
  const safeEntry = { ...entry };
  delete safeEntry.naverPassword;
  delete safeEntry.password;
  fs.appendFileSync(historyPath, `${JSON.stringify(safeEntry)}\n`, "utf8");
}

module.exports = {
  ensureRuntimeFiles,
  readHistory,
  appendHistory
};
