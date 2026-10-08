import { describe, expect, it } from "vitest";
import { cadenceAllowsToday, codeDocsVerdict, docsCadence, docsFactsKey, DOCS_PAUSE_AFTER_MS, DOCS_QUIET_AFTER_MS, fallbackDocsVerdict, type DocsWorthinessFacts } from "../../src/stages/docs-worthiness";
import { createSerialQueue } from "../../src/server/docs-nightly";

const facts = (over: Partial<DocsWorthinessFacts>): DocsWorthinessFacts => ({
  status: "ready", trackedFiles: 100, codeFiles: 0, testFiles: 0, contentFiles: 0, languages: [], commits30d: 5, manifests: [], deploy: false, docsPages: 0, ...over,
});

describe("docs worthiness", () => {
  // Facts of the owner's real folders on 2026-10-01 (Mac mini and OVH).
  it("settles the clear folders in code, the way the owner's folders call for", () => {
    expect(codeDocsVerdict(facts({ codeFiles: 236, manifests: ["package.json"], commits30d: 212 }))).toMatchObject({ need: true, reason: "code_project" });
    expect(codeDocsVerdict(facts({ codeFiles: 4375, manifests: ["package.json"], commits30d: 1698, deploy: true }))).toMatchObject({ need: true, reason: "code_project" });
    expect(codeDocsVerdict(facts({ codeFiles: 0, contentFiles: 7, deploy: true, docsPages: 8 }))).toMatchObject({ need: false, reason: "no_code" });
    expect(codeDocsVerdict(facts({ status: "not-git" }))).toMatchObject({ need: false, reason: "not_git" });
    expect(codeDocsVerdict(facts({ codeFiles: 60 }))).toMatchObject({ need: true, reason: "large_codebase" });
    expect(codeDocsVerdict(facts({ codeFiles: 40, manifests: ["package.json"], commits30d: 0 }))).toMatchObject({ need: false, reason: "inactive" });
    expect(codeDocsVerdict(facts({ codeFiles: 40, manifests: ["package.json"], commits30d: 0, docsPages: 3 }))).toMatchObject({ need: true });
    // treba-sites: 15 js/py without a manifest beside 68 content files is for System One.
    expect(codeDocsVerdict(facts({ codeFiles: 15, contentFiles: 68, commits30d: 74, deploy: true, docsPages: 2 }))).toBeNull();
    expect(fallbackDocsVerdict(facts({ codeFiles: 15 }))).toMatchObject({ need: true, reason: "fallback" });
    expect(fallbackDocsVerdict(facts({ codeFiles: 4 }))).toMatchObject({ need: false });
  });

  it("asks again when the facts that decide move, not on every new file", () => {
    expect(docsFactsKey(facts({ codeFiles: 60 }))).toBe(docsFactsKey(facts({ codeFiles: 900 })));
    expect(docsFactsKey(facts({ codeFiles: 0 }))).not.toBe(docsFactsKey(facts({ codeFiles: 3 })));
    expect(docsFactsKey(facts({ commits30d: 5 }))).not.toBe(docsFactsKey(facts({ commits30d: 0 })));
  });

  it("refreshes docs nobody reads weekly after 60 days and pauses them after 120; a read brings them back", () => {
    const now = 1_000 * 24 * 3_600_000;
    expect(docsCadence({ lastReadAt: now - 10, docsSince: 0, now })).toBe("nightly");
    expect(docsCadence({ lastReadAt: null, docsSince: now - DOCS_QUIET_AFTER_MS, now })).toBe("weekly");
    expect(docsCadence({ lastReadAt: now - DOCS_PAUSE_AFTER_MS, docsSince: 0, now })).toBe("paused");
    expect(docsCadence({ lastReadAt: null, docsSince: now - 5, now })).toBe("nightly");
    expect(cadenceAllowsToday("weekly", "2026-10-05")).toBe(true);
    expect(cadenceAllowsToday("weekly", "2026-10-06")).toBe(false);
    expect(cadenceAllowsToday("paused", "2026-10-05")).toBe(false);
  });

  it("runs queued passes one at a time in order, past a failure", async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    let running = 0, peak = 0;
    const pass = (name: string, fail = false) => queue(async () => {
      running++; peak = Math.max(peak, running); log.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`end ${name}`); running--;
      if (fail) throw new Error(name);
    });
    await Promise.allSettled([pass("a"), pass("b", true), pass("c")]);
    expect(peak).toBe(1);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });
});
