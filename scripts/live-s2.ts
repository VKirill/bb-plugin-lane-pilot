import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256FileOrNull } from "../src/hash";
import { detectStack, installStack, snapshotStack } from "../src/stack-ops";

const home = process.env.HOME!;
const thread = process.argv[2];
if (!thread) throw new Error("usage: live-s2.ts <thread-storage>");
const receiptDir = join(thread, "artifacts");
mkdirSync(receiptDir, { recursive: true });

const watched = [
  join(home, ".agents/install.json"),
  join(home, ".agents/routing.profile.yaml"),
  join(home, ".agents/night-shift.yaml"),
  join(home, ".agents/capabilities.json"),
  join(home, ".claude/settings.json"),
  join(home, ".config/opencode/opencode.jsonc"),
  join(home, ".agents/hooks/guard_shell.py"),
];

async function hashes() {
  return Object.fromEntries(await Promise.all(watched.map(async (path) => [path, await sha256FileOrNull(path)])));
}

const ctx = {
  requestedHostId: "host_7sea4qaad8",
  threadStoragePath: thread,
  receiptDir,
  confirmExternalOps: false,
  localFallbackPath: join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack"),
  guardSourcePath: join(process.cwd(), "lane-stack/hooks/guard_shell.py"),
  pmWorkspacePath: "/Users/vechkasov/Documents/BB-сервис/.agency/jobs/AG-190/tmp/pm-workspace",
  workspacePath: "/Users/vechkasov/Documents/BB-сервис/.agency/jobs/AG-190/tmp/fixture-repo",
  moduleUrl: import.meta.url,
};

const before = await hashes();
const detectBefore = await detectStack(ctx);
const snapshot = await snapshotStack(ctx);
const install = await installStack(ctx);
const detectAfter = await detectStack(ctx);
const after = await hashes();
const summary = { before, after, detectBefore, detectAfter, snapshot, install };
writeFileSync(join(receiptDir, "lane-pilot-live-s2-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  detectBefore: detectBefore.scenario,
  detectAfter: detectAfter.scenario,
  sourceSha: install.sourceSha,
  exitCode: install.exitCode,
  snapshotPath: install.snapshotPath,
  receiptPath: install.receiptPath,
  skipped: install.skippedExternalOps,
}, null, 2));
