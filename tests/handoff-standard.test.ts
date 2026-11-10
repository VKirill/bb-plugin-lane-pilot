import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ANSWER_FORM_LINE, HONEST_EXIT_LINE, JSON_LAST_LINE, READ_ONLY_LINE, REVIEW_READ_ONLY_LINE, helperExit, outputContract } from "@lane-pilot/workflow-engine";
import { OUTPUT_REPEAT_AFTER, renderBrief } from "../src/rooms/brief";

// The guard of the hand-off standard (docs/guide/handoff.md). It reads the source, so a new prompt cannot bring back what the
// standard removed. A list below only shrinks: a file leaves it when its prompt is moved to the standard, none is added.
const root = join(__dirname, "..");
const sources = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((name) => {
  const path = join(dir, name);
  if (name === "node_modules" || name === "dist") return [];
  if (statSync(join(root, path)).isDirectory()) return sources(path);
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
});
const files = [...sources("src"), ...sources("packages")].map((path) => ({ path: relative(".", path), text: readFileSync(join(root, path), "utf8") }));
/** Lines of code only: a comment may quote the old wording to say why it went. */
const code = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
const using = (pattern: RegExp) => files.filter((file) => pattern.test(code(file.text))).map((file) => file.path).sort();

describe("the hand-off standard in the source", () => {
  it("tells no agent with a checkout to open nothing: only the three reviewers that judge data from the hub", () => {
    expect(using(/\bNO_TOOLS_LINE\b/)).toEqual([
      "packages/workflow-engine/src/model-json.ts",
      "src/rooms/night/night.ts",
      "src/rooms/project-life/onboarding.ts",
      "src/rooms/verification/gate-triage.ts",
    ]);
    // The ban written by hand, past the constant: the memory maintainer (no tools by its role) and the constant itself.
    expect(using(/open no files|call no tools|run no commands/i)).toEqual(["packages/memory-core/src/context.ts", "packages/workflow-engine/src/model-json.ts"]);
  });

  it("asks no new helper for «JSON and nothing else»: the form line of the standard, or the engine's contract", () => {
    // One-shot analysers written before the standard; each still parses its own strict form.
    expect(using(/JSON (object|array)? ?(and nothing else|only)|Answer with JSON only|no text before or after it/)).toEqual([
      "packages/council/src/prompts.ts",
      "packages/jev/src/labels-model.ts",
      "packages/memory-core/src/context.ts",
      "src/rooms/docs/docs.ts",
      "src/rooms/learning/autonomy.ts",
      "src/rooms/learning/extract.ts",
      "src/rooms/pm-replay/harvest.ts",
      "src/rooms/project-life/onboarding.ts",
      "src/rooms/self-repair/server/rule-scan.ts",
      "src/rooms/wall/brief.ts",
    ]);
  });

  it("words read-only in two ways, each from its constant", () => {
    // A graph step may write its report under .bb/chats; a reviewer of a task creates nothing, since a change would count as the task's.
    expect(READ_ONLY_LINE).toMatch(/reading is allowed/);
    expect(REVIEW_READ_ONLY_LINE).toMatch(/^Read only:/);
    const literal = (line: string) => files.filter((file) => file.text.includes(line.slice(0, 60)) && !file.path.endsWith("model-json.ts") && !file.path.endsWith("agent-output.ts")).map((file) => file.path);
    expect([...literal(READ_ONLY_LINE), ...literal(REVIEW_READ_ONLY_LINE)]).toEqual([]);
  });
});

describe("the answer side of the standard", () => {
  it("offers the honest exit before the form and puts the object last", () => {
    expect(ANSWER_FORM_LINE.startsWith(JSON_LAST_LINE)).toBe(true);
    expect(ANSWER_FORM_LINE).toContain(HONEST_EXIT_LINE);
    expect(helperExit('```json\n{"outcome":"blocked","blocker":{"needs":"a key","from":"owner"},"handoff":"h"}\n```')).toBe("helper_blocked:needs a key from owner");
    expect(helperExit('{"outcome":"failed","handoff":"no such module"}')).toBe("helper_failed:no such module");
    expect(helperExit('{"status":"pass","summary":"s"}')).toBeNull();
    expect(helperExit("no JSON here")).toBeNull();
  });

  it("the graph step's contract says: reason first, the block last", () => {
    expect(outputContract([{ name: "text", type: "string", required: true }] as never)).toMatch(/Reason in plain text first; the block comes last\.$/);
  });

  it("a brief repeats the answer format after a long data tail, and not after a short one", () => {
    const brief = (size: number) => renderBrief({ role: "generic", goal: "Find the cause", output: "Answer with the cause and the file.", data: [{ tag: "log", text: "x".repeat(size) }] }).text;
    expect(brief(OUTPUT_REPEAT_AFTER + 1).endsWith("The answer format again:\nAnswer with the cause and the file.")).toBe(true);
    expect(brief(200)).not.toContain("The answer format again");
    expect(brief(200).endsWith("The task again: Find the cause")).toBe(true);
  });
});
