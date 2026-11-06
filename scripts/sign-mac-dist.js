const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "darwin") {
  console.log("Skipped macOS ad-hoc signing on non-darwin platform.");
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
const appBundle = path.join(root, "dist", "mac-arm64", "Naver Blog Automator.app");

const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", appBundle], {
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(`Ad-hoc signed ${appBundle}`);
