import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/rooms/plugin-db";
import { runMemoryEvalCommand } from "../src/rooms/memory-eval/server/command";
import { E2E_VERDICTS, ABSTAIN_PHRASE, e2eCases, formatE2e, parseVerdict, runE2e, stubModel, type ModelCall } from "../src/rooms/memory-eval/server/e2e";
import { formatPublic, loadFactConsolidation, loadLongMemEvalAbstention, runFactConsolidation, runLongMemEvalAbstention } from "../src/rooms/memory-eval/server/public-sets";
import { formatSuite, plantSuite, regressions, runSuite, scoreSuite, standInEmbedding, type SuiteBaseline } from "../src/rooms/memory-eval/server/suite";
import { SUITE_CASES, SUITE_NOTES } from "../src/rooms/memory-eval/server/suite-fixture";
import baseline from "../src/rooms/memory-eval/server/suite-baseline.json";

// The offline memory suite (H1-H7 of the memory research, 2026-11-13). Update the baseline on purpose:
//   npx tsx scripts/memory-eval.ts --suite --write-baseline src/rooms/memory-eval/server/suite-baseline.json
describe("memory suite: the fixture", () => {
  it("names only notes it plants, and plants each note once", () => {
    const keys = SUITE_NOTES.map((note) => note.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(SUITE_CASES.map((item) => item.id)).size).toBe(SUITE_CASES.length);
    for (const item of SUITE_CASES) for (const key of [...(item.expect === "nothing" ? [] : item.expect), ...(item.forbid ?? [])]) expect(keys, `${item.id} names ${key}`).toContain(key);
    for (const note of SUITE_NOTES) if (note.supersedes) expect(keys.indexOf(note.supersedes)).toBeLessThan(keys.indexOf(note.key));
  });

  it("covers the six families of cases the research asks for, with a leak pair for each kind of boundary", () => {
    const by = (family: string) => SUITE_CASES.filter((item) => item.family === family);
    expect(["H1", "H2", "H3", "H4", "H5", "H6"].map((family) => by(family).length >= 6)).toEqual(Array(6).fill(true));
    expect(by("H3").some((item) => item.kind === "near-miss")).toBe(true);
    expect(new Set(by("H4").map((item) => item.kind))).toEqual(new Set(["number", "polarity", "conclusion"]));
    expect(new Set(by("H5").map((item) => item.kind))).toEqual(new Set(["sibling", "root", "nested", "audience", "shared", "control"]));
  });

  it("plants through the write door: a replaced version is hidden, the new one is active, every vector is made offline", () => {
    const plant = plantSuite(migrations);
    const status = (key: string) => (plant.db as never as { prepare(sql: string): { get(id: string): { status: string } } }).prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(plant.ids.get(key)!).status;
    expect(status("weight-old")).toBe("superseded");
    expect(status("weight-new")).toBe("active");
    expect(status("web-map")).toBe("active");
    const vectors = (plant.db as never as { prepare(sql: string): { get(): { n: number } } }).prepare("SELECT count(*) n FROM lane_pilot_memory_vec").get().n;
    expect(vectors).toBeGreaterThan(30);
    expect(standInEmbedding("the order queue")).toEqual(standInEmbedding("the order queue"));
  });
});

describe("memory suite: retrieval scores", () => {
  const report = runSuite(migrations);

  it("prints the score table", () => {
    process.stdout.write(`\n${formatSuite(report, baseline as SuiteBaseline)}\n\n`);
    expect(report.families.map((row) => row.family)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H8", "H9", "H10", "H7"]);
  });

  it("H5: no note of another section or audience reaches a reader, and the controls still arrive", () => {
    expect(report.leaks).toEqual([]);
    const controls = report.cases.filter((item) => item.kind === "control" || item.kind === "shared");
    expect(controls.length).toBeGreaterThan(4);
    for (const item of controls) expect(item.missing, item.id).toEqual([]);
  });

  it("fails only on a regression below the recorded baseline", () => {
    expect(regressions(report, baseline as SuiteBaseline)).toEqual([]);
  });

  it("a worse run is a regression: a leak, a family below its baseline, a larger context", () => {
    const worse = scoreSuite(report.cases.map((item) => item.id === "h5-web-from-api" ? { ...item, pass: false, leaked: ["web-map"] } : item.id === "h2-queue" ? { ...item, pass: false, missing: ["queue"] } : { ...item, tokens: item.tokens * 3 }));
    const found = regressions(worse, baseline as SuiteBaseline);
    expect(found.join("\n")).toMatch(/leakage \(H5\): h5-web-from-api: web-map/);
    expect(found.join("\n")).toMatch(/H2 fell from 8\/8 to 7\/8 \(failing: h2-queue\)/);
    expect(found.join("\n")).toMatch(/H7 context grew/);
  });
});

describe("memory suite: end to end with a stub model", () => {
  it("takes the PM questions round-robin over the families so a small limit touches each", () => {
    const some = e2eCases(10);
    expect(some).toHaveLength(10);
    expect(new Set(some.map((item) => item.family))).toEqual(new Set(["H2", "H3", "H4", "H5", "H6", "H8", "H9", "H10"]));
    expect(e2eCases().every((item) => item.surface === "pm")).toBe(true);
  });

  it("dry-runs the pipeline: context and question to the model, the judge's verdict counted, tokens added up", async () => {
    const report = await runE2e(migrations, stubModel, { limit: 20 });
    expect(report.rows).toHaveLength(20);
    expect(report.calls).toBe(40);
    expect(report.tokensIn).toBeGreaterThan(report.tokensOut);
    expect(report.counts.unparsed).toBe(0);
    expect(Object.values(report.counts).reduce((sum, value) => sum + value, 0)).toBe(20);
    expect(report.abstainedCorrect.of + report.answeredCorrect.of).toBe(20);
    expect(report.answeredCorrect.n).toBeGreaterThan(5);
    expect(formatE2e(report)).toMatch(/memory e2e: 20 questions, 40 model calls[\s\S]*cost: ~\d+ tokens in/);
  });

  it("scores a model that always answers as hallucinating on the questions with no answer, and one that never answers as abstaining wrongly", async () => {
    const answerer: ModelCall = async (prompt, label) => label === "answer" ? "The value is 42 and it lives in services/made-up/file.ts." : stubModel(prompt, label, "");
    const refuser: ModelCall = async (prompt, label) => label === "answer" ? ABSTAIN_PHRASE : stubModel(prompt, label, "");
    const loud = await runE2e(migrations, answerer, { limit: 20 });
    const quiet = await runE2e(migrations, refuser, { limit: 20 });
    expect(loud.abstainedCorrect.n).toBe(0);
    expect(loud.hallucinated.n).toBeGreaterThan(0);
    expect(quiet.answeredCorrect.n).toBe(0);
    expect(quiet.counts["abstained-wrong"]).toBe(quiet.answeredCorrect.of);
    expect(quiet.abstainedCorrect.n).toBe(quiet.abstainedCorrect.of);
  });

  it("reads a verdict from the judge's JSON or from a bare label, and marks the rest unparsed", () => {
    for (const verdict of E2E_VERDICTS) expect(parseVerdict(`{"verdict":"${verdict}"}`)).toBe(verdict);
    expect(parseVerdict("I think this is hallucinated")).toBe("hallucinated");
    expect(parseVerdict("no idea")).toBe("unparsed");
  });
});

describe("memory suite: the command", () => {
  it("--suite prints the table and exits 0 against the baseline; --e2e needs the plugin's model unless --stub", async () => {
    const suite = await runMemoryEvalCommand(null, ["--suite"], migrations);
    expect(suite.exitCode).toBe(0);
    expect(suite.stdout).toContain("no regression against the baseline");
    expect(JSON.parse((await runMemoryEvalCommand(null, ["--suite", "--json"], migrations)).stdout!).regressions).toEqual([]);
    expect((await runMemoryEvalCommand(null, ["--suite", "--write-baseline", "x.json"], migrations)).stderr).toMatch(/scripts\/memory-eval/);
    expect((await runMemoryEvalCommand(null, ["--longmemeval", "x.json"], migrations)).stderr).toMatch(/scripts\/memory-eval/);
    const bare = await runMemoryEvalCommand(null, ["--e2e"], migrations);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toMatch(/calls a model/);
    const asked: string[] = [];
    const wired = await runMemoryEvalCommand(null, ["--e2e", "--project", "P1", "--limit", "3"], migrations, { model: (project) => async (prompt, label) => { asked.push(`${project}:${label}`); return stubModel(prompt, label, ""); } });
    expect(wired.exitCode).toBe(0);
    expect(asked).toEqual(["P1:answer", "P1:judge", "P1:answer", "P1:judge", "P1:answer", "P1:judge"]);
    const dry = await runMemoryEvalCommand(null, ["--e2e", "--stub", "--limit", "4"], migrations);
    expect(dry.stdout).toMatch(/memory e2e: 4 questions/);
    expect((await runMemoryEvalCommand(null, ["--e2e", "--stub", "--limit", "0"], migrations)).stderr).toMatch(/--limit/);
  });
});

describe("memory suite: public sets from local files", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-public-"));
  const read = (path: string) => readFileSync(path, "utf8");

  it("loads the abstention questions of a LongMemEval-S file and scores abstention", () => {
    const round = (text: string) => [{ role: "user", content: text }, { role: "assistant", content: "Noted." }];
    const file = join(dir, "lme.json");
    writeFileSync(file, JSON.stringify([
      { question_id: "q1", question: "Where do I live?", haystack_sessions: [round("I enjoy hiking in the alps")] },
      { question_id: "q2_abs", question: "What is the name of my pet dragon?", haystack_sessions: [round("I enjoy hiking in the alps"), round("My favorite soup is tomato basil"), round("Remind me to renew the passport")] },
    ]));
    const cases = loadLongMemEvalAbstention(file, read);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.rounds).toHaveLength(3);
    const report = runLongMemEvalAbstention(migrations, cases);
    expect(report.abstained).toEqual({ n: 1, of: 1 });
    expect(formatPublic(report)).toMatch(/LongMemEval-S abstention: 1 questions, abstained or warned 1\/1/);
    expect(() => loadLongMemEvalAbstention(writeJson("bad.json", [{ question_id: "x_abs", question: "q" }]), read)).toThrow(/haystack_sessions/);
  });

  it("loads FactConsolidation rows and checks that the newest fact reaches the context", () => {
    const file = join(dir, "fc.jsonl");
    writeFileSync(file, `${JSON.stringify({ context: "0. The capital of Zorbia is Alpha City.\n1. The mayor of Quenta is Ruth Marlowe.\n2. The capital of Zorbia is Beta Town.", questions: ["What is the capital of Zorbia?"], answers: [["Beta Town"]] })}\n`);
    const cases = loadFactConsolidation(file, read);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.facts).toHaveLength(3);
    const report = runFactConsolidation(migrations, cases);
    expect(report.answerInContext).toEqual({ n: 1, of: 1 });
    expect(() => loadFactConsolidation(writeJson("bad.jsonl", { context: "0. A fact that is long enough." }), read)).toThrow(/questions and answers/);
  });

  const writeJson = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, name.endsWith(".jsonl") ? `${JSON.stringify(value)}\n` : JSON.stringify(value)); return path; };
});
