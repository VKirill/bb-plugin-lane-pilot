#!/usr/bin/env node
// Writes src/rooms/sma-map/contracts.ts: for each SMA card id, the tests that hold Lane Pilot to the card's behaviour. A test names its
// card in its title, `[sma:px_stop] stops the running writer ...`; one test may name several cards. Tests in a sibling repository
// (the BB core: core:, the Telegram plugin: telegram:) are read from git at a pinned commit; the rules — and what --check does when a
// sibling is absent — are in src/rooms/sma-map/contract-index.ts. --check exits 1 when the file is stale.
//   node scripts/sma-contracts.mjs [--check]          SMA_SIBLING_CORE / SMA_SIBLING_TELEGRAM=<checkout>|off pick the siblings
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
// The builder is TypeScript (it shares the sibling resolution with the plugin): run under tsx (re-exec once when started by plain node).
if (!process.env.SMA_CONTRACTS_TSX) {
  const run = spawnSync("npx", ["tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { cwd: root, stdio: "inherit", env: { ...process.env, SMA_CONTRACTS_TSX: "1" } });
  process.exit(run.status ?? 1);
}

const target = join(root, "src", "rooms", "sma-map", "contracts.ts");
const { buildContracts } = await import("../src/rooms/sma-map/contract-index.ts");
const current = existsSync(target) ? await import(`${target}?t=${Date.now()}`) : {};
const check = process.argv.includes("--check");
const { out, notes, cards, tests } = buildContracts({ root, check, current: { tests: current.SMA_CONTRACT_TESTS ?? {}, at: current.SMA_SIBLING_TESTS_AT ?? {} } });
for (const note of notes) process.stderr.write(`note: ${note}\n`);
if (check) {
  if (readFileSync(target, "utf8") !== out) { console.error("src/rooms/sma-map/contracts.ts is stale: run node scripts/sma-contracts.mjs"); process.exit(1); }
  process.exit(0);
}
writeFileSync(target, out);
console.log(`${cards} cards checked by ${tests} test(s) -> ${relative(root, target)}`);
