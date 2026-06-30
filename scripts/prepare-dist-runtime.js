const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_SETTINGS } = require("../src/lib/settings");
const { DEFAULT_ACCOUNT_STORE } = require("../src/lib/accountStore");

const root = path.resolve(__dirname, "..");
const targets = [
  path.join(root, "dist", "runtime"),
  path.join(root, "dist", "win-unpacked", "runtime")
];

for (const runtimeRoot of targets) {
  fs.mkdirSync(path.join(runtimeRoot, "image"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "jobs"), { recursive: true });
  const historyPath = path.join(runtimeRoot, "blog_history.jsonl");
  if (!fs.existsSync(historyPath)) {
    fs.writeFileSync(historyPath, "", "utf8");
  }
  const settingsPath = path.join(runtimeRoot, "user-settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, "utf8");
  }
  const accountStorePath = path.join(runtimeRoot, "account-categories.json");
  if (!fs.existsSync(accountStorePath)) {
    fs.writeFileSync(accountStorePath, `${JSON.stringify(DEFAULT_ACCOUNT_STORE, null, 2)}\n`, "utf8");
  }
}

console.log("Prepared distributable runtime folders.");
