import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walkProdFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkProdFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts") && !/\.(test|spec)\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const PROD_FILES = [
  ...walkProdFiles(join(ROOT, "src")),
  join(ROOT, "server.ts"),
].map((file) => ({ rel: relative(ROOT, file).replace(/\\/g, "/"), text: readFileSync(file, "utf8") }));

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function scanPattern(pattern: RegExp, allow: Set<string>) {
  const hits: string[] = [];
  const matched = new Set<string>();
  for (const { rel, text } of PROD_FILES) {
    const clean = stripComments(text);
    const matches = pattern.test(clean);
    if (matches) matched.add(rel);
    if (matches && !allow.has(rel)) {
      clean.split("\n").forEach((line, idx) => {
        if (pattern.test(line)) hits.push(`${rel}:${idx + 1}: ${line.trim()}`);
      });
    }
  }
  const stale = [...allow].filter((rel) => !existsSync(join(ROOT, rel)) || !matched.has(rel));
  return { hits, stale };
}

describe("single engine clock and no ad-hoc timers or pollers", () => {
  it("allows scheduleIsolated only in its definition and the one engine-clock home", () => {
    const allow = new Set([
      "src/rooms/platform/server/services/schedules.ts",
      "src/rooms/schedule/server/handlers/board-clock.ts",
    ]);
    const { hits, stale } = scanPattern(/\bscheduleIsolated\(/, allow);
    expect(hits).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("forbids direct bb.background.schedule or experimental_vkSchedule outside the scheduleIsolated wrapper", () => {
    const allow = new Set(["src/rooms/platform/server/services/schedules.ts"]);
    const { hits, stale } = scanPattern(/\b(?:bb\.background\.schedule\(|experimental_vkSchedule\b)/, allow);
    expect(hits).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("forbids ad-hoc engine.poll / workflowEngine.poll calls in runtime code", () => {
    const { hits, stale } = scanPattern(/\b(?:workflowEngine\??\.poll|engine\.poll)\(/, new Set());
    expect(hits).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("allows setInterval only in its audited worker, guard, and UI query-poll homes", () => {
    const allow = new Set([
      "src/rooms/host-worker/job-runner.ts",
      "src/rooms/project-git/server/services/dispatch-guard.ts",
      "src/rooms/stability/server/services/thread-event-feed.ts",
      "src/rooms/ui-shell/ui/use-lp-rpc-query.ts",
      "src/rooms/workflow/server/services/workflow-agent-guard.ts",
      "src/rooms/writer/server/services/spawn-watchdog.ts",
    ]);
    const { hits, stale } = scanPattern(/\bsetInterval\(/, allow);
    expect(hits).toEqual([]);
    expect(stale).toEqual([]);
  });
});
