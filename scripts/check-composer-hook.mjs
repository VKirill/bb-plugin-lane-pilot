import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
for (const rel of ["server.ts", "host.ts", "src/composer-selection.ts"]) {
  const text = readFileSync(join(root, rel), "utf8");
  if (text.includes("@get-bb/plugin-sdk/app")) {
    console.error(`${rel} imports frontend SDK /app — backend reload will fail`);
    process.exit(1);
  }
}
console.log("backend sources do not import @get-bb/plugin-sdk/app");
