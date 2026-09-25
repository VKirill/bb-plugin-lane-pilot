import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dirname, "../dist/app.js"), "utf8");
if (!app.includes("experimental_useComposerSelection")) {
  console.error("dist/app.js missing experimental_useComposerSelection — rebuild with composer-215 CLI and env -u BB_CLI");
  process.exit(1);
}
console.log("composer hook present in dist/app.js");
