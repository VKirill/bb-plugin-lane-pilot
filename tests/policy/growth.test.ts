import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXAM, EXAM_LIVE, examSchema, liveExamSchema } from "../../src/rooms/policy/exam";
import { examShrank, freezeProblems, ownerOnlyShrank } from "../../src/rooms/policy/growth";
import { POLICY, parsePolicy } from "../../src/rooms/policy/policy";

/** A policy committed before version 2 has none of the freeze fields; give it neutral ones so it can be compared. */
const legacy = (raw: unknown) => {
  const old = raw as Record<string, unknown> & { exam: Record<string, unknown> };
  return parsePolicy({ frozen_at: "2000-01-01T00:00:00Z", frozen_hash: "0".repeat(64), standing_prohibitions: [], ...old, exam: { live_file: "", min_items: 1, ...old.exam } });
};

const ROOT = join(__dirname, "..", "..");
/** A committed version of a file, or null when HEAD has none (the file is new, or this is no git checkout). */
function committed(file: string): unknown | null {
  try { return JSON.parse(execFileSync("git", ["show", `HEAD:${file}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 })); }
  catch { return null; }
}

describe("owner_only never shrinks", () => {
  it("is not smaller than the previous committed version", () => {
    const previous = committed("policy/night-policy.json");
    if (!previous) return; // no HEAD version: nothing to compare against
    expect(ownerOnlyShrank(legacy(previous), POLICY)).toEqual([]);
  });

  it("a changed list is a new version: higher version, later freeze", () => {
    const previous = committed("policy/night-policy.json");
    if (!previous) return;
    const before = legacy(previous);
    // A version-1 file has no freeze fields: any freeze is later than none.
    expect(freezeProblems({ version: before.version, frozen_at: before.frozen_at, frozen_hash: before.frozen_hash }, POLICY)).toEqual([]);
  });

  it("the exam (v1, history) keeps every item it had", () => {
    const previous = committed("policy/exam.json");
    if (!previous) return;
    expect(examShrank(examSchema.parse(previous), EXAM)).toEqual([]);
  });

  it("exam v2 only grows: no item removed, edited or re-dated", () => {
    const previous = committed("policy/exam-v2.json");
    if (!previous) return;
    expect(examShrank(liveExamSchema.parse(previous), EXAM_LIVE)).toEqual([]);
  });

  describe("freezeProblems", () => {
    const v = (version: number, frozen_at: string, frozen_hash: string) => ({ version, frozen_at, frozen_hash });
    it("same lists, same version: nothing to say", () => {
      expect(freezeProblems(v(2, "2026-10-22T11:00:00Z", "a"), v(2, "2026-10-22T11:00:00Z", "a"))).toEqual([]);
    });
    it("same lists with a moved freeze: refused (the freeze time is what keeps items unseen)", () => {
      expect(freezeProblems(v(2, "2026-10-22T11:00:00Z", "a"), v(2, "2026-10-23T11:00:00Z", "a"))).toHaveLength(1);
    });
    it("changed lists keeping the old version or the old freeze: refused", () => {
      expect(freezeProblems(v(2, "2026-10-22T11:00:00Z", "a"), v(2, "2026-10-23T11:00:00Z", "b"))).toHaveLength(1);
      expect(freezeProblems(v(2, "2026-10-22T11:00:00Z", "a"), v(3, "2026-10-22T11:00:00Z", "b"))).toHaveLength(1);
      expect(freezeProblems(v(2, "2026-10-22T11:00:00Z", "a"), v(2, "2026-10-22T10:00:00Z", "b"))).toHaveLength(2);
    });
    it("changed lists with a new version and a later freeze: fine", () => {
      expect(freezeProblems(v(2, "2026-10-22T11:00:00Z", "a"), v(3, "2026-10-23T11:00:00Z", "b"))).toEqual([]);
    });
  });

  describe("the comparison itself", () => {
    const copy = () => JSON.parse(JSON.stringify(POLICY)) as typeof POLICY;

    it("accepts an identical policy and a grown one", () => {
      expect(ownerOnlyShrank(POLICY, POLICY)).toEqual([]);
      const grown = copy();
      grown.owner_only.push({ id: "extra", description: "x", examples: ["x"], match: [{ kinds: ["x"] }] });
      grown.owner_only[0]!.match.push({ kinds: ["more"] });
      expect(ownerOnlyShrank(POLICY, grown)).toEqual([]);
    });

    it("sees a removed entry", () => {
      const shrunk = copy();
      shrunk.owner_only = shrunk.owner_only.filter((entry) => entry.id !== "judge_gates");
      expect(ownerOnlyShrank(POLICY, shrunk)).toEqual([expect.stringContaining("judge_gates")]);
    });

    it("sees an entry moved to a softer list", () => {
      const moved = copy();
      const entry = moved.owner_only.find((e) => e.id === "spending_caps")!;
      moved.owner_only = moved.owner_only.filter((e) => e !== entry);
      moved.night_proposes.push(entry);
      expect(ownerOnlyShrank(POLICY, moved)).toEqual([expect.stringContaining("spending_caps")]);
    });

    it("sees a glob removed from a matcher and a field added to one (a narrower matcher)", () => {
      const fewerGlobs = copy();
      const gates = fewerGlobs.owner_only.find((e) => e.id === "judge_gates")!;
      gates.match[1]!.files_any = gates.match[1]!.files_any!.slice(1);
      expect(ownerOnlyShrank(POLICY, fewerGlobs)).toHaveLength(1);

      const narrower = copy();
      narrower.owner_only.find((e) => e.id === "irreversible_data")!.match[0]!.attrs = { backup: false };
      expect(ownerOnlyShrank(POLICY, narrower)).toHaveLength(1);
    });

    it("sees a standing prohibition removed or narrowed", () => {
      const gone = copy();
      gone.standing_prohibitions = gone.standing_prohibitions.filter((entry) => entry.id !== "never_fast_tier_default");
      expect(ownerOnlyShrank(POLICY, gone)).toEqual([expect.stringContaining("never_fast_tier_default")]);
      const narrower = copy();
      narrower.standing_prohibitions.find((entry) => entry.id === "never_acp_opencode")!.match[0]!.attrs = { provider: "acp-opencode", role: "writer" };
      expect(ownerOnlyShrank(POLICY, narrower)).toHaveLength(1);
      const grown = copy();
      grown.standing_prohibitions.push({ ...grown.standing_prohibitions[0]!, id: "never_extra" });
      expect(ownerOnlyShrank(POLICY, grown)).toEqual([]);
    });

    it("sees the minimum number of unseen items lowered", () => {
      const lower = copy();
      lower.exam.min_items = 5;
      expect(ownerOnlyShrank(POLICY, lower)).toEqual([expect.stringContaining("min_items")]);
    });

    it("sees an exam-v2 item re-dated", () => {
      const item = { id: "y_000000000001", descriptor: { kind: "x" }, expected: "owner_only" as const, decided_at: "2026-10-23T00:00:00Z" };
      expect(examShrank({ items: [item] }, { items: [{ ...item, decided_at: "2026-10-21T00:00:00Z" }] })).toEqual([expect.stringContaining("was edited")]);
    });

    it("sees the exam bar lowered", () => {
      const lower = copy();
      lower.exam.min_accuracy = 0.5;
      expect(ownerOnlyShrank(POLICY, lower)).toEqual([expect.stringContaining("min_accuracy")]);
    });

    it("sees exam items dropped or relabelled", () => {
      const items = EXAM.items;
      expect(examShrank({ items }, { items })).toEqual([]);
      expect(examShrank({ items }, { items: items.slice(1) })).toEqual([`exam item ${items[0]!.id} is gone`]);
      const relabelled = items.map((item, index) => (index === 0 ? { ...item, expected: item.expected === "owner_only" ? ("night_decides" as const) : ("owner_only" as const) } : item));
      expect(examShrank({ items }, { items: relabelled })).toEqual([expect.stringContaining("was edited")]);
    });
  });
});
