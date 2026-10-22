import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COVERAGE, REQUIRED_MECHANISMS, checkReceipt, codeNodes, coverageRows, holes, summarize, type DrillReceipt } from "../src/rooms/coverage";
import { renderCoverage, runCoverageCli } from "../src/rooms/coverage/cli";

const ROOT = join(__dirname, "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
/** A test file's text, with the shared suite it registers (tests/stages/server-stage/partN.test.ts → suite.ts). */
const textOf = (file: string) => read(file) + (/from "\.\/suite"/.test(read(file)) ? read(join(file, "..", "suite.ts")) : "");

const drillScenarios = (): string[] => {
  const all = /^ALL = \[([^\]]+)\]/m.exec(read("scripts/lp-drill.py"))![1]!;
  return [...all.matchAll(/"(\w+)"/g)].map((match) => match[1]!);
};
const failureClasses = (): string[] => /export type FailureClass = ([^;]+);/.exec(read("src/rooms/runs/failure-class.ts"))![1]!.split("|").map((part) => part.trim().replace(/"/g, ""));
const rooms = (): string[] => readdirSync(join(ROOT, "src/rooms")).filter((name) => statSync(join(ROOT, "src/rooms", name)).isDirectory()).sort();

describe("the coverage registry (graph ↔ drill)", () => {
  const rows = coverageRows();
  const nodes = [...codeNodes(),
    ...failureClasses().map((id) => ({ kind: "failure_class" as const, id })),
    ...rooms().map((id) => ({ kind: "room" as const, id })),
  ];

  it("has an entry for every stage, attempt transition, gate, memory path, failure class and room, and none for a node that is gone", () => {
    const found = holes(rows, nodes);
    expect(found.missing, "a new stage / transition / gate / memory path / failure class / room needs an entry in src/rooms/coverage/registry.ts (live scenario, or tests and the reason no drill covers it)").toEqual([]);
    expect(found.stale).toEqual([]);
    expect(found.duplicate).toEqual([]);
    // Failure classes and rooms are listed by this test (the code has a type and a directory), so check both ways here.
    const wantedOthers = new Set(nodes.filter((node) => node.kind === "failure_class" || node.kind === "room").map((node) => `${node.kind}:${node.id}`));
    const haveOthers = rows.filter((row) => row.kind === "failure_class" || row.kind === "room").map((row) => `${row.kind}:${row.id}`);
    expect(haveOthers.filter((node) => !wantedOthers.has(node))).toEqual([]);
  });

  it("covers the stages, mechanisms and tables the spec names", () => {
    const mechanisms = new Set(rows.filter((row) => row.kind === "mechanism").map((row) => row.id));
    expect([...REQUIRED_MECHANISMS].filter((id) => !mechanisms.has(id))).toEqual([]);
    for (const kind of ["stage", "transition", "failure_class", "gate", "memory_path", "room", "mechanism"] as const) expect(rows.some((row) => row.kind === kind), kind).toBe(true);
  });

  it("names only drill scenarios that exist, and a live claim has a scenario and a way it is exercised", () => {
    const known = new Set(drillScenarios());
    expect(known.size).toBeGreaterThanOrEqual(12);
    for (const entry of COVERAGE) {
      for (const scenario of entry.live ?? []) expect(known.has(scenario), `${entry.ids[0]}: no drill scenario «${scenario}» in scripts/lp-drill.py`).toBe(true);
      if (entry.live?.length) expect((entry.via ?? "").length, `${entry.ids[0]}: say how the drill exercises it (via)`).toBeGreaterThan(15);
    }
  });

  it("gives every node that no drill scenario runs a stated reason, and never an empty claim", () => {
    for (const entry of COVERAGE) {
      const id = `${entry.kind}:${entry.ids.join(",")}`;
      if (!entry.live?.length) expect((entry.reason ?? "").length, `${id}: no drill scenario runs it, so say why in reason`).toBeGreaterThan(30);
      expect(entry.live?.length || entry.tests?.length || entry.reason, id).toBeTruthy();
    }
    for (const row of rows.filter((item) => item.status === "none")) expect(row.note.length, `${row.kind}:${row.id}`).toBeGreaterThan(20);
  });

  it("cites only test files that exist, and a test-only entry cites a test that really mentions its node", () => {
    const bad: string[] = [];
    for (const entry of COVERAGE) {
      for (const file of entry.tests ?? []) if (!existsSync(join(ROOT, file))) bad.push(`${entry.ids[0]}: ${file} does not exist`);
      if (entry.live?.length || !entry.tests?.length) continue;
      for (const id of entry.ids) {
        const mentioned = entry.tests.filter((file) => existsSync(join(ROOT, file))).some((file) => {
          const text = textOf(file);
          if (entry.kind === "stage" || entry.kind === "gate" || entry.kind === "failure_class") return text.includes(id);
          if (entry.kind === "room") return text.includes(`rooms/${id}`);
          return true;
        });
        if (!mentioned) bad.push(`${entry.kind}:${id}: none of ${entry.tests.join(", ")} mentions it`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("reports the counts: live, tests only, not covered", () => {
    const all = summarize(rows).all;
    expect(all.live + all.tests + all.none).toBe(rows.length);
    expect(all.live).toBeGreaterThan(20);
    expect(all.tests).toBeGreaterThan(20);
    // A memory path the probe cannot ask is exempt with its reason: it shows as not covered, with that reason.
    const exempt = rows.filter((row) => row.kind === "memory_path" && row.status === "none");
    for (const row of exempt) expect(row.note).not.toBe("");
  });

  it("prints the table: counts first, then one line per node with the drill scenario or the tests and the reason", () => {
    const text = renderCoverage(rows);
    expect(text).toMatch(/^Lane Pilot coverage: \d+ nodes — covered live \d+, by tests only \d+, not covered \d+\./);
    expect(text).toContain("kind            live  tests  none  total");
    expect(text).toMatch(/live {3}stage:writer-agent {2}drill: parallel3/);
    expect(text).toMatch(/tests {2}stage:verification {2}tests: tests\/dispatch-verification-check.test.ts.*not live: drill tasks carry verification/);
    const cli = runCoverageCli(["--kind", "gate", "--status", "live"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("gate:owns-paths");
    expect(cli.stdout).not.toContain("gate:verification");
    expect(runCoverageCli(["--kind", "nope"])).toMatchObject({ exitCode: 1 });
    const json = JSON.parse(runCoverageCli(["--json"]).stdout!);
    expect(json.gaps).toEqual([]);
    expect(json.summary.all.total).toBe(rows.length);
  });
});

describe("the live claims against a drill receipt", () => {
  const rows = coverageRows();
  const receipt = JSON.parse(read("tests/fixtures/drill-seen-2026-10-22.json")) as DrillReceipt;

  it("the quick drill of 2026-10-22 left on the hub what the registry claims for its scenarios", () => {
    const verdict = checkReceipt(rows, receipt);
    expect(verdict.evidence).toBe(true);
    expect(verdict.notSeen).toEqual([]);
    expect(verdict.checked).toBeGreaterThan(10);
    expect(verdict.confirmed).toBe(verdict.checked);
  });

  it("flags a claim the run did not leave evidence for, and says so when a receipt records nothing", () => {
    const without = structuredClone(receipt);
    delete without.seen!.stages!["writer-agent"];
    delete without.seen!.gates!["owns-paths"];
    const verdict = checkReceipt(rows, without);
    expect(verdict.notSeen.join("\n")).toContain("stage:writer-agent");
    expect(verdict.notSeen.join("\n")).toContain("gate:owns-paths");
    expect(checkReceipt(rows, { scenarioNames: ["parallel3"], seen: null })).toMatchObject({ evidence: false, checked: 0 });
    // Claims of scenarios the receipt did not run are not checked.
    expect(checkReceipt(rows, { scenarioNames: ["guard_hash"], seen: { stages: {}, gates: {}, moves: {} } }).checked).toBe(0);
  });

  it("the drill script records what the run left (seen) in its receipt", () => {
    const source = read("scripts/lp-drill.py");
    expect(source).toContain("def evidence_seen(run_id");
    expect(source).toContain('"seen": evidence_seen(ctx.run_id)');
  });
});
