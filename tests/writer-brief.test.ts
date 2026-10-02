import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { taskV2Schema } from "../src/contracts";
import { compactContract, pathAnchors, pmReadBrief, writerMemory } from "../src/writer-brief";
import { writerPrompt } from "../src/server/writer-task";

// The real brief SelfyStudio's writer got for gc-pages-polish-2 on 2026-10-02 (4130 tokens, 64% memory).
const original = readFileSync(join(__dirname, "fixtures/writer-brief-gc-pages-polish-2.md"), "utf8");
const task = taskV2Schema.parse(JSON.parse(original.slice(original.indexOf('{\n  "schema_version"'))));
const notes = original.slice(original.indexOf("Relevant project memory"), original.indexOf("PM read context")).split("\n")
  .filter((line) => line.startsWith("- [note"))
  .map((line) => { const match = /^- \[note; concepts=([^\]]*)\] (.*)$/s.exec(line)!; return { concepts:match[1]!.split(", "), content:match[2]! }; });
const pmRead = original.slice(original.indexOf('{"summary"'), original.indexOf("\n", original.indexOf('{"summary"')));
const packet = original.slice(original.indexOf("Read these before editing"), original.indexOf("\n\n", original.indexOf("Read these before editing")));

describe("writer brief", () => {
  it("anchors memory on two-segment path tails, leaving tool caches out", () => {
    expect(pathAnchors(task).sort()).toEqual(["components/greeting-cards", "composables/__tests__", "composables/useGreetingCard", "marketing/i18n", "src/site-tool-card-page"]);
  });

  it("keeps the one note about this task's paths out of seventeen, and no raw failure episodes", () => {
    expect(notes).toHaveLength(17);
    const memory = writerMemory(notes, task);
    expect(memory.split("\n")).toHaveLength(1);
    expect(memory).toContain("packages/contracts/src/site-tool-card-page/");
    expect(memory).not.toMatch(/attempt failed|concepts=/);
  });

  it("gives the writer the read stage's facts and the PM its open questions", () => {
    const brief = pmReadBrief(pmRead);
    expect(brief.facts.split("\n")).toHaveLength(7);
    expect(brief.facts).not.toContain("summary");
    expect(brief.openQuestions).toHaveLength(4);
    expect(pmReadBrief("plain text summary")).toEqual({ facts:"plain text summary", openQuestions:[] });
  });

  it("states the contract once: no workspace copies, no empty or default fields", () => {
    const contract = compactContract(task, true);
    expect(contract).not.toHaveProperty("schema_version");
    expect(contract).not.toHaveProperty("project_cwd");
    expect(contract).not.toHaveProperty("depends_on");
    expect(contract).not.toHaveProperty("read_first");
    expect(contract.verification).toEqual(task.verification.map((row) => row.command));
    expect(compactContract(task, false)).toHaveProperty("read_first");
  });

  it("is under a third of the old brief, fixed rules first, the new-files rule included", () => {
    const brief = writerPrompt(task, writerMemory(notes, task), packet, undefined, "Lane Pilot writer", pmRead, "");
    expect(brief.length).toBeLessThan(original.length / 3);
    expect(brief.startsWith("You are Lane Pilot writer")).toBe(true);
    expect(brief).toMatch(/every path you create must match an owns_paths pattern/);
    expect(brief.indexOf("NEEDS_HUMAN")).toBeLessThan(brief.indexOf("Workspace:"));
    expect(brief.split(task.project_cwd)).toHaveLength(2);
    expect(brief.split(task.objective)).toHaveLength(2);
    expect(brief).not.toContain("openQuestions");
  });
});
