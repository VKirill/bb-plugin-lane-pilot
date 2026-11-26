import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MODEL_PRICES } from "@lane-pilot/models";
import { HELPER_ROLES } from "../../src/rooms/contracts/helper-context";
import { paidModelPrice, paidRowUsd } from "../../src/rooms/money";
import { postOwnerItem } from "../../src/rooms/owner-waiting";
import { openDatabase } from "../../src/rooms/plugin-db";

const ROOT = process.cwd();

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkTsFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const SOURCE_CONTENTS = [
  ...walkTsFiles(join(ROOT, "src")),
  ...walkTsFiles(join(ROOT, "packages")).filter((f) => !f.includes("/tests/")),
  join(ROOT, "server.ts"),
  join(ROOT, "host.ts"),
  join(ROOT, "app.tsx"),
].map((file) => ({ rel: relative(ROOT, file).replace(/\\/g, "/"), text: readFileSync(file, "utf8") }));

describe("one home per shared vocabulary", () => {
  it("keeps terminal attempt state literals in state-machine.ts only", () => {
    const ALLOWED = new Set([
      "packages/contracts/src/attempt-states.ts",
      "src/rooms/contracts/state-machine.ts",
      "packages/handoff/src/contract.ts",
      "src/rooms/runs/server/services/task-board.ts",
      "src/rooms/contracts/ui-query-schemas.ts",
    ]);
    const LITERAL_PAIR = /["']accepted["']\s*,\s*(?:["']blocked["']\s*,\s*)?["']canceled["']|["']canceled["']\s*,\s*(?:["']blocked["']\s*,\s*)?["']accepted["']/;
    const hits: string[] = [];
    for (const { rel, text } of SOURCE_CONTENTS) {
      if (ALLOWED.has(rel)) continue;
      if (!LITERAL_PAIR.test(text)) continue;
      text.split("\n").forEach((line, idx) => {
        if (LITERAL_PAIR.test(line)) hits.push(`${rel}:${idx + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("keeps the test-path regex in tasks/rails.ts only", () => {
    const ALLOWED = new Set(["src/rooms/tasks/models/rails.ts"]);
    const TEST_REGEX_TEXT = /\(\^\|\\\/\)\(__tests__\|tests\?\|spec\)\/\|\(\?:__tests__\|tests\?\)|\(\^\|\\\/\)\(tests\?\|__tests__\)\/\|\.\(test\|spec\)/;
    const hits: string[] = [];
    for (const { rel, text } of SOURCE_CONTENTS) {
      if (ALLOWED.has(rel)) continue;
      if (TEST_REGEX_TEXT.test(text)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("keeps process.env.BB_HOST_ID reads in packages/kit/src/env.ts only", () => {
    const ALLOWED = new Set(["packages/kit/src/env.ts"]);
    const hits: string[] = [];
    for (const { rel, text } of SOURCE_CONTENTS) {
      if (ALLOWED.has(rel)) continue;
      if (/process\.env\.BB_HOST_ID/.test(text)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("keeps guard_shell.py helper roles in 1:1 parity with HelperRole", () => {
    const guardPy = readFileSync(join(ROOT, "lane-stack/hooks/guard_shell.py"), "utf8");
    const match = /LANE_PILOT_HELPER_ROLES\s*=\s*\{([\s\S]*?)\}/.exec(guardPy);
    expect(match).not.toBeNull();
    const pyRoles = new Set(
      match![1]!
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean),
    );
    const CODER_ROLES = new Set(["writer", "code-repair", "night-fixer"]);
    const tsHelperRoles = new Set(
      HELPER_ROLES.filter((role) => !CODER_ROLES.has(role) && !role.startsWith("specialist:")),
    );
    expect([...pyRoles].sort()).toEqual([...tsHelperRoles].sort());

    const specMatch = /LANE_PILOT_SPECIALIST_ROLES\s*=\s*\{([\s\S]*?)\}/.exec(guardPy);
    expect(specMatch).not.toBeNull();
    const pySpecialists = new Set(
      specMatch![1]!
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean),
    );
    const tsSpecialists = new Set(
      HELPER_ROLES.filter((role) => role.startsWith("specialist:")).map((role) => role.slice("specialist:".length)),
    );
    expect([...pySpecialists].sort()).toEqual([...tsSpecialists].sort());
  });

  it("uses MODEL_PRICES for Opus and returns not_measured for unpriced paid lanes", () => {
    const opus = paidModelPrice("anthropic", "claude-opus-5");
    expect(opus).toEqual({
      inputPerM: MODEL_PRICES["claude-opus-5"]!.input,
      outputPerM: MODEL_PRICES["claude-opus-5"]!.output,
      cachedPerM: MODEL_PRICES["claude-opus-5"]!.cacheRead,
    });
    expect(
      paidRowUsd({
        day: "2026-11-25",
        providerId: "openlux",
        model: "unknown-unpriced-model",
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 0,
      }),
    ).toBe("not_measured");
  });

  it("refuses postOwnerItem without a valid reason and logs a warning", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const logs: string[] = [];
    const res = postOwnerItem(
      db,
      { key: "test:no-reason", source: "writer", kind: "question", what: "q", why: "w" } as never,
      Date.now(),
      (msg) => logs.push(msg),
    );
    expect(res).toEqual({ created: false });
    expect(logs).toEqual(["owner item refused source=writer kind=question (no reason)"]);
  });
});
