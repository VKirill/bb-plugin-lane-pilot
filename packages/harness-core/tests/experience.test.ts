import { describe, expect, it } from "vitest";
import { experienceIsSupported, parseEdits, parseExperience, parseNotes, renderExperienceMarkdown } from "../src/index";

const reply = `Some preamble the model wrote.

<edits>
component: checks/colocated-tests.sh
candidates: inv1, agg1
change: added a check that the diff touches a spec next to each changed composable
observed: attempt a-t3 wrote the spec after the check failed once; a-t1 and a-t2 under base shipped none
verdict: helped
component: always-on.md
candidates: dom1
change: a paragraph on Nuxt conventions
observed: no attempt read it differently; the two attempts under dom1 behaved as base
verdict: No observed effect.
component: memory.md
candidates: dom1
change: a note on the hreflang mapping
observed: changed together with the paragraph; one attempt only
verdict: confounded
component: hooks.json
candidates: inv1
verdict: wat
</edits>

<experience>
cue: when a change to a composable ships without its colocated spec and the acceptance rejects it
lesson: add a check (checks/*.sh) that fails when a changed composable has no spec in the diff; do not add prose about tests
evidence: row checks/colocated-tests.sh (helped, a-t3 vs a-t1/a-t2)
confidence: medium, one area, three attempts
</experience>`;

describe("notes", () => {
  it("takes the notes block and recognises KEEP_BASE", () => {
    expect(parseNotes("<notes>kept -> x -> a-t1 step 4</notes>")).toEqual({ notes: "kept -> x -> a-t1 step 4", keepBase: false });
    expect(parseNotes("<notes>KEEP_BASE: 2/2 attempts already ran the spec</notes>").keepBase).toBe(true);
    expect(parseNotes("no block, plain text").notes).toBe("no block, plain text");
  });
});

describe("edits", () => {
  it("parses rows, normalises verdict case and drops a row with a verdict outside the four", () => {
    const rows = parseEdits(reply);
    expect(rows.map((row) => [row.component, row.verdict])).toEqual([
      ["checks/colocated-tests.sh", "helped"],
      ["always-on.md", "no observed effect"],
      ["memory.md", "confounded"],
    ]);
    expect(rows[0]).toMatchObject({ candidates: "inv1, agg1", observed: expect.stringContaining("a-t3") });
    expect(parseEdits("nothing here")).toEqual([]);
  });
});

describe("experience", () => {
  it("parses the lesson with its confidence level", () => {
    expect(parseExperience(reply)).toMatchObject({ cue: expect.stringContaining("colocated spec"), lesson: expect.stringContaining("checks/*.sh"), evidence: expect.stringContaining("helped"), confidence: "medium" });
    expect(parseExperience(reply)?.edits).toContain("component: checks/colocated-tests.sh");
  });

  it("returns null for NO_ENTRY, a missing block, or a block missing cue, lesson or evidence", () => {
    expect(parseExperience("<edits></edits>\n\nNO_ENTRY")).toBeNull();
    expect(parseExperience("<experience>\nNO_ENTRY\n</experience>")).toBeNull();
    expect(parseExperience("<experience>\ncue: x\nlesson: y\n</experience>")).toBeNull();
    expect(parseExperience("plain")).toBeNull();
  });

  it("does not count a lesson that rests only on confounded rows", () => {
    const experience = parseExperience(reply)!;
    expect(experienceIsSupported(experience, parseEdits(reply))).toBe(true);
    expect(experienceIsSupported(experience, [{ component: "memory.md", candidates: "", change: "", observed: "", verdict: "confounded" }])).toBe(false);
    expect(experienceIsSupported(null, [])).toBe(false);
    expect(experienceIsSupported(experience, [])).toBe(true);
  });

  it("renders EXPERIENCE.md with the rows and the lesson, or NO_ENTRY", () => {
    const md = renderExperienceMarkdown({ title: "page:/tools/cards", adopted: "agg1", inventory: "1 check; 40 always-on tokens", why: "fewer rejections", rows: parseEdits(reply), experience: parseExperience(reply) });
    expect(md).toContain("| checks/colocated-tests.sh | inv1, agg1 |");
    expect(md).toContain("- **cue**: when a change to a composable");
    expect(renderExperienceMarkdown({ title: "t", adopted: "base", inventory: "x", rows: [], experience: null })).toContain("NO_ENTRY");
  });
});
