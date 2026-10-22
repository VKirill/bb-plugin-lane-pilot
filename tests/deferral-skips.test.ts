import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEED_ENTRIES } from "../src/rooms/deferral/seed";
import { citedDeferralIds, scanSkips } from "../src/rooms/deferral/skips";

// SMA rule 5: `it.todo` without a term is a silent hole. Every skipped test names the register entry that excuses it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The comment marker is built here so that this file's own samples are not read as citations by the scan.
const mark = (id: string) => `// ${"deferral"}:${id}`;
const RUNTIME_ID = /^dfr_[0-9a-f]{12}$/;

describe("skipped tests carry a deferral", () => {
  it("every skip, todo and skipIf in tests/ cites an entry: a seeded one, or a runtime id the deploy drill checks against the register", () => {
    const seeded = new Set(SEED_ENTRIES.map((entry) => entry.id));
    const sites = scanSkips(ROOT);
    expect(sites.length).toBeGreaterThan(20);
    const bare = sites.filter((site) => !site.deferralId).map((site) => `${site.file}:${site.line}  ${site.code}`);
    expect(bare, `add "${mark("<id>")}" above each skipped test, with the id of an open entry of the register (bb lane-pilot defer … --kind skipped_test)`).toEqual([]);
    const unknown = sites.filter((site) => site.deferralId && !seeded.has(site.deferralId) && !RUNTIME_ID.test(site.deferralId))
      .map((site) => `${site.file}:${site.line} cites ${site.deferralId}`);
    expect(unknown).toEqual([]);
  });

  it("every seeded skip entry is cited by at least one skip, so the register holds no entry for a test that is gone", () => {
    const cited = new Set(citedDeferralIds(ROOT));
    const idle = SEED_ENTRIES.filter((entry) => entry.kind === "skipped_test" && !cited.has(entry.id)).map((entry) => entry.id);
    expect(idle).toEqual([]);
  });

  it("the five old plan decisions are in the register and in the plan file they came from", () => {
    const plan = join(ROOT, ".agents/plans/2026-10-05-harness-engineering-gaps.md");
    const decisions = SEED_ENTRIES.filter((entry) => entry.kind === "plan_decision");
    expect(decisions).toHaveLength(5);
    if (!existsSync(plan)) return;
    const text = readFileSync(plan, "utf8");
    const waiting = text.slice(text.indexOf("## Waiting for owner decision"));
    expect(waiting.match(/^- \[ \] /gm)).toHaveLength(5);
    for (const heading of ["Harness eval / replay", "Containment of writers/critics", "Code critique default on", "Automatic browser QA", "Non-idempotent verification"]) {
      expect(waiting).toContain(heading);
    }
  });
});

describe("the scan", () => {
  function sample(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "lp-skips-"));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), body);
    }
    return root;
  }

  it("finds skip, todo, skipIf, xit and xdescribe, with the mark on the line or the line above, and ignores comments", () => {
    const root = sample({
      "tests/a.test.ts": readFileSync(join(ROOT, "tests/fixtures/deferral-skips/a.txt"), "utf8"),
      "packages/p/tests/b.test.ts": `${"describe"}.${"skip"}("pkg", () => {});`,
      "node_modules/x/tests/c.test.ts": `${"it"}.${"skip"}("dependency", () => {});`,
    });
    const sites = scanSkips(root).map((site) => `${site.file}:${site.line}:${site.deferralId}`);
    expect(sites).toEqual([
      "tests/a.test.ts:2:dfr_aaaaaaaaaaaa",
      "tests/a.test.ts:3:dfr_bbbbbbbbbbbb",
      "tests/a.test.ts:4:null",
      "tests/a.test.ts:8:dfr_cccccccccccc",
      "tests/a.test.ts:9:null",
      "tests/a.test.ts:13:null",
      "packages/p/tests/b.test.ts:1:null",
    ]);
  });

  it("lists the ids cited anywhere in the test folders", () => {
    const root = sample({ "tests/a.test.ts": readFileSync(join(ROOT, "tests/fixtures/deferral-skips/a.txt"), "utf8"), "tests/sub/b.test.ts": mark("dfr_seed_skip_guard") });
    expect(citedDeferralIds(root)).toEqual(["dfr_aaaaaaaaaaaa", "dfr_bbbbbbbbbbbb", "dfr_cccccccccccc", "dfr_dddddddddddd", "dfr_seed_skip_guard"]);
  });
});
