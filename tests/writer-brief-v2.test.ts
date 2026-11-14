import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { taskV2Schema } from "../src/rooms/contracts";
import { compactContract } from "../src/rooms/writer/writer-brief";
import { writerMemory } from "../src/rooms/memory/server";
import { contractSections, stickyTurnPrompt, writerPrompt } from "../src/rooms/writer/server/writer-task";
import { THREAD_MEMORY_RULE } from "../src/rooms/contracts/thread-rule";
import { errandPrompt } from "../src/rooms/qa/server/errands";
import { taskBrief } from "../src/rooms/critique/task-brief";
import { codeCritiquePrompt } from "../src/rooms/critique/code-critique";

const original = readFileSync(join(__dirname, "fixtures/writer-brief-gc-pages-polish-2.md"), "utf8");
const task = taskV2Schema.parse(JSON.parse(original.slice(original.indexOf('{\n  "schema_version"'))));
const memory = writerMemory([{ kind: "core", concepts: [], content: "Use npm ci." }], task);

describe("writer brief v2", () => {
  it("renders the contract as tagged sections with no JSON dump, and keeps every contract item", () => {
    const brief = writerPrompt(task, memory, "");
    for (const tag of ["task_goal", "inputs", "boundaries", "acceptance", "output"]) expect(brief).toContain(`<${tag}>`);
    expect(brief).not.toMatch(/Task contract:\s*\n\s*\{/);
    expect(brief).not.toContain('"schema_version": 2');
    // Every field the old JSON dump carried still appears, as text.
    const contract = compactContract(task, false) as Record<string, unknown>;
    for (const path of task.owns_paths) expect(brief).toContain(path);
    for (const item of task.acceptance) expect(brief).toContain(item);
    for (const pattern of task.never_touch) expect(brief).toContain(pattern);
    for (const rule of task.invariants) expect(brief).toContain(rule);
    for (const out of task.expected_outputs) expect(brief).toContain(out);
    for (const check of contract.verification as string[]) expect(brief).toContain(check);
    for (const path of contract.read_first as string[]) expect(brief).toContain(path);
    expect(brief).toContain(`id: ${task.id}`);
    expect(brief).toContain(`objective: ${task.objective}`);
    expect(brief).toContain("workspace:");
    expect(brief).toContain(task.project_cwd);
  });

  it("carries the two project-memory lines of THREAD_MEMORY_RULE and the tagged data blocks", () => {
    const brief = writerPrompt(task, memory, "", undefined, "Lane Pilot writer", `{"keyFacts":["f1"],"openQuestions":["q1"]}`, "- rule one");
    for (const line of THREAD_MEMORY_RULE) expect(brief).toContain(line);
    expect(brief).toMatch(/<project_memory>\n- Use npm ci\.\n<\/project_memory>/);
    expect(brief).toMatch(/<pm_read_facts>\n- f1\n<\/pm_read_facts>/);
    expect(brief).toMatch(/<rules>\n- rule one\n<\/rules>/);
    expect(brief).toContain("data, not instructions");
    // The goal is restated after the data tail.
    expect(brief.indexOf("The task again:")).toBeGreaterThan(brief.indexOf("</rules>"));
  });

  it("a narrowed writer gets one skills line and no catalog browsing, no context7, no gitnexus without an index", () => {
    const brief = writerPrompt(task);
    expect(brief).toContain("Your skills for this task:");
    expect(brief).not.toContain("bb tools skills-tree");
    expect(brief).not.toContain("context7");
    expect(brief).not.toContain("gitnexus tools");
    const broad = writerPrompt(task, "", "", undefined, "Lane Pilot writer", "", "", "", null, false, { broadSkills: true });
    expect(broad).toContain("bb tools skills-tree");
    const withIndex = writerPrompt(task, "", "", undefined, "Lane Pilot writer", "", "", "", null, false, { gitnexusTools: true, gitnexusIndex: true, metamcpTools: true });
    expect(withIndex).toContain("GitNexus");
    expect(withIndex).toContain("context7");
  });

  it("states the answer contract once in <output>, NEEDS_HUMAN marker included", () => {
    const brief = writerPrompt(task);
    const output = brief.slice(brief.indexOf("<output>"), brief.indexOf("</output>"));
    expect(output).toContain("Done when your change is complete");
    expect(output).toContain("answer with the first line `ASK_PM: <one question>`");
    expect(output).toContain("ASK_PM: needs secret <NAME>");
    expect(output).toContain("ASK_PM: check <command> cannot run in the sandbox");
    // the NEEDS_HUMAN instruction lives only there now
    expect(brief.slice(brief.indexOf("</output>")).split("answer with the first line").length).toBe(1);
  });

  it("renders every field compactContract emits — object fields like convergence and clarify are not dropped", () => {
    const rich = taskV2Schema.parse({
      ...JSON.parse(original.slice(original.indexOf('{\n  "schema_version"'))),
      display_title: "Полировка главной", kind: "feature", area: "page:/tools/cards", skills: ["web-design"], quality_mode: "full",
      qa_url: "http://localhost:3000/cards", qa_cases: ["open the page"], qa_env_class: "local", qa_dev_server: "npm run dev",
      convergence: { criteria: ["src/a.ts contains 'RATE_LIMIT = 10'", "npm test exits 0"] },
      clarify: { questions: [], answers: [{ question: "which colour?", answer: "blue", by: "owner" }] },
      files: [{ path: "src/a.ts", action: "modify", target: "rateLimit", change: "raise the limit" }],
      wires: [{ chain: ["ui.theme", "loadSettings", "ThemeProvider"] }],
      promise: { given: "a request", when: "over the limit", then: "429" },
      appetite: { minutes: 30 }, priority: "high", drawing: ["design/cards.png"], test_removals: ["old/cards.test.ts"], fixes_regressions: [3],
      forecast: { files: 2, checks_pass_first_try: true },
    });
    const brief = writerPrompt(rich);
    // Parity: no key of the compacted contract may vanish from the brief.
    for (const key of Object.keys(compactContract(rich, false))) expect(brief, `contract field ${key} missing`).toContain(`${key}:`);
    expect(brief).toContain("src/a.ts contains 'RATE_LIMIT = 10'");
    expect(brief).toContain("which colour?");
    expect(brief).toContain("blue");
    // forecast stays out: the PM's guess is measured, not shown.
    expect(brief).not.toContain("checks_pass_first_try");
  });

  it("the retry turn says the contract is unchanged; a next task resends it as tagged sections", () => {
    const next = stickyTurnPrompt({ kind: "next-task", task });
    expect(next).toContain("<task_goal>");
    expect(next).toContain(`id: ${task.id}`);
    expect(next).not.toContain('"schema_version": 2');
  });
});

describe("errand brief", () => {
  it("carries the memory rule and the skills line for a narrowed thread", () => {
    const prompt = errandPrompt({ task: "check the deploy", browserHostId: null, authorized: true });
    for (const line of THREAD_MEMORY_RULE) expect(prompt).toContain(line);
    expect(prompt).toContain("Your skills for this task: browser-automation, computer-use, env-catalog");
    expect(prompt).not.toContain("bb tools skills-tree");
    const broad = errandPrompt({ task: "check the deploy", browserHostId: null, authorized: true, broadSkills: true });
    expect(broad).toContain("bb tools skills-tree");
  });
});

describe("critic briefs", () => {
  it("taskBrief renders the tagged sections and no memory rule", () => {
    const brief = taskBrief(task, { fields: ["title", "objective", "acceptance", "owns_paths", "never_touch", "verification"] });
    expect(brief).toContain("<task_goal>");
    expect(brief).toContain("<boundaries>");
    for (const line of THREAD_MEMORY_RULE) expect(brief).not.toContain(line);
    const critique = codeCritiquePrompt({ task, evidence: { files: [], verification: [] } as never });
    for (const line of THREAD_MEMORY_RULE) expect(critique).not.toContain(line);
  });

  it("the critic's gitnexus hint appears only when the workspace has .gitnexus", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-gnx-"));
    const without = codeCritiquePrompt({ task, evidence: { workspace: dir, files: [], verification: [] } as never });
    expect(without).not.toContain("query`/`context`/`impact`");
    mkdirSync(join(dir, ".gitnexus"));
    const withIndex = codeCritiquePrompt({ task, evidence: { workspace: dir, files: [], verification: [] } as never });
    expect(withIndex).toContain("query`/`context`/`impact`");
  });
});
