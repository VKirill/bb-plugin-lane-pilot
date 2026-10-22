import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXAM, examSchema } from "../../src/rooms/policy/exam";
import { examShrank, ownerOnlyShrank } from "../../src/rooms/policy/growth";
import { POLICY, parsePolicy } from "../../src/rooms/policy/policy";

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
    expect(ownerOnlyShrank(parsePolicy(previous), POLICY)).toEqual([]);
  });

  it("the exam keeps every item it had", () => {
    const previous = committed("policy/exam.json");
    if (!previous) return;
    expect(examShrank(examSchema.parse(previous), EXAM)).toEqual([]);
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
