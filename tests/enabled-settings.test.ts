import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_ATTEMPT_BUDGET } from "../src/rooms/writer/retry-budget";
import { MAIN_ATTEMPT_LIMIT } from "../src/rooms/runs/state-machine";
import { DEFAULT_QUALITY_MODE } from "../src/rooms/critique/quality-mode";
import { parseMemorySettings } from "../packages/memory-core/src/settings";

const root = join(import.meta.dirname, "..");

describe("the generated enabled-settings page", () => {
  it("docs/enabled-settings.md was generated from the catalog and snapshot the repo has now", () => {
    const out = execFileSync("npx", ["tsx", "scripts/generate-enabled-settings.ts", "--check"], { cwd: root, encoding: "utf8" });
    expect(out).toContain("matches the code");
  });
  // The values the page states as code defaults are the constants the code holds; a drift fails here, not in prose.
  it("the stated defaults are the code's", () => {
    const page = readFileSync(join(root, "docs/enabled-settings.md"), "utf8");
    expect(page).toContain(`\`TASK_ATTEMPT_BUDGET\` | \`${TASK_ATTEMPT_BUDGET}\``);
    expect(page).toContain(`\`MAIN_ATTEMPT_LIMIT\` | \`${MAIN_ATTEMPT_LIMIT}\``);
    expect(page).toContain(`\`quality_mode (no task/project value)\` | \`${DEFAULT_QUALITY_MODE}\``);
    expect(page).toContain(`\`memory.note_budget\` | \`${parseMemorySettings({}).noteBudget}\``);
  });
});
