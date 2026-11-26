import { describe, expect, it } from "vitest";
import { runSim } from "./chain-harness";
import { humanOptions, humanOutput } from "../../src/rooms/workflow/server/services/workflow-human-form";

const conflict = { topic: "mode", a_path: "ADR.md", a_line: 1, a_quote: "one", a_kind: "ADR", b_path: "PRD.md", b_line: 2, b_quote: "two", b_kind: "PRD", winner: "a", rule: "precedence" };

describe("[sma:k_ag_docsynth] precedence engine preflight", () => {
  it.each([
    ["P1", ["ADR", "PRD"], "a", ["ADR.md", "PRD.md"], true],
    ["P2", ["PRD", "ADR"], "b", ["ADR.md", "PRD.md"], true],
    ["P5", ["SPEC", "ADR", "DOC", "PRD"], "a", ["ADR.md", "PRD.md"], true],
    ["N1", [], "a", ["ADR.md", "PRD.md"], false],
    ["N2", ["PRD", "ADR"], "a", ["ADR.md", "PRD.md"], false],
    ["N3", ["ADR"], "a", ["ADR.md", "PRD.md"], false],
    ["N4", ["ADR", "PRD", "ADR"], "a", ["ADR.md", "PRD.md"], false],
    ["duplicate ADR only", ["ADR", "ADR"], "a", ["ADR.md", "PRD.md"], false],
    ["duplicate PRD only", ["PRD", "PRD"], "b", ["ADR.md", "PRD.md"], false],
    ["duplicate and missing", ["SPEC", "ADR", "ADR"], "a", ["ADR.md", "PRD.md"], false],
    ["paths outside input", ["ADR", "PRD"], "a", ["docs/"], false],
  ])("%s verifies order and membership", async (_name, precedence, winner, paths, expected) => {
    const r = await runSim("docs-synthesis-check", { input: { conflict: { ...conflict, winner }, paths, precedence } });
    expect(r.summary.status, JSON.stringify(r.summary)).toBe("succeeded");
    expect(r.summary.output).toMatchObject({ auto_resolved: expected });
  });
  it("runs the rank graph", async () => {
    const r = await runSim("docs-synthesis-rank", { input: { kind: "ADR" } });
    expect(r.summary).toMatchObject({ status: "succeeded", output: { kind: "ADR" } });
  });
});

describe("[sma:k_ag_docsynth] document synthesis", () => {
  it("declares arrays at all input, output and join boundaries", () => {
    for (const id of ["docs-synthesis", "docs-synthesis-check"]) {
      const flow = builtinWorkflow(id)!;
      for (const name of ["paths", "precedence"]) expect(flow.inputs.find((field) => field.name === name)?.type).toBe("array");
      for (const node of flow.nodes) if (node.type === "parallel") expect(node.join?.out.find((field) => field.name === "results")?.type).toBe("array");
    }
    const flow = builtinWorkflow("docs-synthesis")!;
    expect(flow.outputs.find((field) => field.name === "conflicts")?.type).toBe("array");
    for (const [id, name] of [["classify", "documents"], ["synth", "conflicts"]]) {
      const node = flow.nodes.find((item) => item.id === id)!;
      if (node.type !== "agent") throw new Error(`expected agent ${id}`);
      expect(node.out.find((field) => field.name === name)?.type).toBe("array");
    }
  });

  it("validates docs-synthesis-check", async () => {
    const r = await runSim("docs-synthesis-check", { input: { conflict } });
    expect(r.summary.status, JSON.stringify(r.summary)).toBe("succeeded");
    expect(r.summary.output).toMatchObject(conflict);
  });
  it("validates records and writes the report", async () => {
    const r = await runSim("docs-synthesis", { input: { paths: ["ADR.md", "PRD.md"], precedence: ["ADR", "PRD"] }, stubs: { synth: { conflicts: [conflict] }, "fs.write": { markdown_path: "report.md", json_path: "report.json" } } });
    expect(r.summary.status, JSON.stringify(r.summary)).toBe("succeeded");
    expect(r.summary.output).toMatchObject({ status: "done", owner_response: "none", conflicts: [{ ...conflict, auto_resolved: true }] });
  });
  it.each([
    ["missing quote", { b_quote: undefined }], ["empty quote", { b_quote: "" }],
    ["wrong line type", { b_line: "12" }], ["same position", { b_path: "ADR.md", b_line: 1 }],
    ["winner without rule", { winner: "a", rule: "none" }], ["rule without winner", { winner: "none", rule: "precedence" }],
    ["same kind precedence", { b_kind: "ADR" }],
  ])("refuses %s before asking or writing", async (_name, change) => {
    for (const precedence of [undefined, ["ADR", "PRD"]]) {
      const r = await runSim("docs-synthesis", { input: { paths: ["ADR.md", "PRD.md"], ...(precedence ? { precedence } : {}) }, stubs: { synth: { conflicts: [{ ...conflict, ...change }] }, "fs.write": { markdown_path: "report.md", json_path: "report.json" } }, status: "failed" });
      expect(r.summary.status, JSON.stringify(r.summary)).toBe("failed");
      expect(r.called("resolve")).toHaveLength(0);
      expect(r.called("write_md")).toHaveLength(0);
      expect(r.called("write_json")).toHaveLength(0);
    }
  });
  it.each([
    [{ answer_kind: "timeout", answer: "" }, "open"],
    [{ answer_kind: "keep_both", answer: "" }, "open"],
    [{ answer_kind: "decided", answer: "" }, "open"],
    [{ answer_kind: "decided", answer: "owner words" }, "open"],
  ])("preserves unresolved owner disposition %j", async (answer, status) => {
    const r = await runSim("docs-synthesis", { input: { paths: [] }, stubs: { synth: { conflicts: [{ ...conflict, winner: "none", rule: "none" }] }, "fs.write": { markdown_path: "report.md", json_path: "report.json" } }, humans: { resolve: answer } });
    expect(r.summary.status, JSON.stringify(r.summary)).toBe("succeeded");
    expect(r.summary.output).toMatchObject({ status });
    expect(r.called("resolve")).toHaveLength(1);
  });
  it.each([
    ["P1", ["ADR", "PRD"], "a", ["ADR.md", "PRD.md"], true],
    ["P2", ["PRD", "ADR"], "b", ["ADR.md", "PRD.md"], true],
    ["P5", ["SPEC", "ADR", "DOC", "PRD"], "a", ["ADR.md", "PRD.md"], true],
    ["N1 absent", undefined, "a", ["ADR.md", "PRD.md"], false],
    ["N2 opposite", ["PRD", "ADR"], "a", ["ADR.md", "PRD.md"], false],
    ["N3 missing", ["ADR"], "a", ["ADR.md", "PRD.md"], false],
    ["N4 duplicate", ["ADR", "PRD", "ADR"], "a", ["ADR.md", "PRD.md"], false],
    ["N5 lowercase", ["adr", "prd"], "a", ["ADR.md", "PRD.md"], false],
    ["N6 folder", ["ADR", "PRD"], "a", ["docs/"], false],
    ["duplicate ADR only", ["ADR", "ADR"], "a", ["ADR.md", "PRD.md"], false],
    ["duplicate PRD only", ["PRD", "PRD"], "b", ["ADR.md", "PRD.md"], false],
    ["duplicate missing", ["SPEC", "ADR", "ADR"], "a", ["ADR.md", "PRD.md"], false],
  ])("%s routes claims based on verified precedence", async (_name, precedence, winner, paths, valid) => {
    const input = { paths, ...(precedence ? { precedence } : {}) };
    const r = await runSim("docs-synthesis", { input, stubs: { synth: { conflicts: [{ ...conflict, winner }] }, "fs.write": { markdown_path: "report.md", json_path: "report.json" } }, humans: { resolve: { answer_kind: "timeout", answer: "" } } });
    expect(r.summary.status, JSON.stringify(r.summary)).toBe("succeeded");
    expect(r.summary.output).toMatchObject({ status: valid ? "done" : "open", owner_response: valid ? "none" : "timeout", conflicts: [{ ...conflict, winner, auto_resolved: valid }] });
    expect(r.called("resolve")).toHaveLength(valid ? 0 : 1);
  });
  it.each([
    ["P3", "AGENTS.md", "CLAUDE.md", "a", true],
    ["P4", "CLAUDE.md", "AGENTS.md", "b", true],
    ["N7", "ADR.md", "PRD.md", "a", false],
    ["N8", "CLAUDE.md", "AGENTS.md", "a", false],
    ["N9", "docs/AGENTS.md", "docs/CLAUDE.md", "a", false],
  ])("%s checks the literal AGENTS over CLAUDE rule", async (_name, a_path, b_path, winner, valid) => {
    const item = { ...conflict, a_path, b_path, a_kind: "DOC", b_kind: "DOC", winner, rule: "agents_over_claude" };
    const r = await runSim("docs-synthesis", { input: { paths: [a_path, b_path] }, stubs: { synth: { conflicts: [item] }, "fs.write": { markdown_path: "report.md", json_path: "report.json" } }, humans: { resolve: { answer_kind: "timeout", answer: "" } } });
    expect(r.summary.status, JSON.stringify(r.summary)).toBe("succeeded");
    expect(r.summary.output).toMatchObject({ status: valid ? "done" : "open", conflicts: [{ ...item, auto_resolved: valid }] });
    expect(r.called("resolve")).toHaveLength(valid ? 0 : 1);
  });
  it("retains both records when just one claim is verified", async () => {
    const other = { ...conflict, topic: "other", winner: "b" };
    const r = await runSim("docs-synthesis", { input: { paths: ["ADR.md", "PRD.md"], precedence: ["ADR", "PRD"] }, stubs: { synth: { conflicts: [conflict, other] }, "fs.write": { markdown_path: "report.md", json_path: "report.json" } }, humans: { resolve: { answer_kind: "timeout", answer: "" } } });
    expect(r.summary.output).toMatchObject({ status: "open", conflicts: [{ ...conflict, auto_resolved: true }, { ...other, auto_resolved: false }] });
    expect(r.called("resolve")).toHaveLength(1);
  });
  it("requires a real form choice; free text and whitespace do not select one", () => {
    const node = builtinWorkflow("docs-synthesis")!.nodes.find((item) => item.id === "resolve")!;
    if (node.type !== "human") throw new Error("expected human node");
    expect(humanOptions(node)).toEqual(["decided", "keep_both"]);
    for (const text of ["maybe the ADR, not sure", "   ", "решай сам"]) expect(humanOutput(node, { choiceIndex: null, text })).toBeNull();
    expect(humanOutput(node, { choiceIndex: 1, text: "use ADR" })).toMatchObject({ answer_kind: "decided", answer: "use ADR" });
  });

  it("handles no conflicts and refuses over 50", async () => {
    const empty = await runSim("docs-synthesis", { input: { paths: [] }, stubs: { synth: { conflicts: [] }, "fs.write": { markdown_path: "report.md", json_path: "report.json" } } });
    expect(empty.summary.status, JSON.stringify(empty.summary)).toBe("succeeded");
    expect(empty.summary.output).toMatchObject({ status: "done", conflicts: [] });
    const large = await runSim("docs-synthesis", { input: { paths: [] }, stubs: { synth: { conflicts: Array(51).fill(conflict) }, "fs.write": { markdown_path: "report.md", json_path: "report.json" } }, status: "failed" });
    expect(large.summary.status).toBe("failed");
    expect(large.called("resolve")).toHaveLength(0);
    expect(large.called("write_md")).toHaveLength(0);
  });

});

import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { createCore } from "../../src/rooms/core/server/core";
import { openDatabase, createRun, setRunThread } from "../../src/rooms/plugin-db";
import { registerCheckoutActions } from "../../src/rooms/workflow/server/services/workflow-checkout-actions";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { coreFileWrite, diskStore } from "../helpers/core-files";
import { sha256Hex } from "@lane-pilot/kit";

async function diskFixture(records: unknown) {
  const checkout = mkdtempSync(join(tmpdir(), "lp-docs-synthesis-"));
  writeFileSync(join(checkout, "ADR.md"), "one\n");
  writeFileSync(join(checkout, "PRD.md"), "line\ntwo\n");
  let clock = 1_000_000;
  const writes: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
    threads: { get: async () => ({ id: "pm", environmentId: "env" }) as never },
    environments: { get: async () => ({ id: "env", hostId: "local", path: checkout }) as never },
    files: {
      write: coreFileWrite(diskStore(), (path) => writes.push(path)) as never,
      read: async (args: unknown) => {
        const path = String((args as { path: string }).path);
        if (!existsSync(path)) throw Object.assign(new Error("not found"), { code: "not_found", serverCode: "file_not_found" });
        const content = readFileSync(path, "utf8");
        return { content, sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content), contentEncoding: "utf8", truncated: false };
      },
    },
  } });
  const db = openDatabase(bb);
  createRun(db, "run", "project", "bb", checkout, "none", undefined, "local");
  setRunThread(db, "run", "pm");
  const ctx = createCore(bb, db);
  const engine = new WorkflowEngine({ db, harnessVersion: "test", now: () => clock, resolveWorkflow: (id) => builtinWorkflow(id) });
  engine.register("agent", { reentrant: true, run: async (step) => ({ output: step.nodeId === "synth" ? { conflicts: records, handoff: "synth" } : { documents: [], handoff: "classify" } }) });
  registerCheckoutActions(engine, ctx, { planHome: async () => null, flagOf: () => false, action: (key, handler) => engine.register(key, { reentrant: true, run: async (step: StepContext) => ({ output: await handler(step as never, step.runtime as never) }) }) });
  const start = () => engine.start({ workflow: builtinWorkflow("docs-synthesis")!, inputs: { paths: ["ADR.md", "PRD.md"], precedence: ["ADR", "PRD"] }, runtime: { ctx, services: {}, pmThreadId: "pm", projectId: "project", runId: "run" }, link: { projectId: "project", runId: "run" } });
  return { engine, db, checkout, writes, start, advance: (ms: number) => { clock += ms; }, dispose: () => { engine.dispose(); db.close(); harness.lifecycle.dispose(); rmSync(checkout, { recursive: true, force: true }); } };
}

describe("[sma:k_ag_docsynth] document synthesis through registered checkout writes", () => {
  it.each([
    ["paths", { paths: "ADR.md", precedence: ["ADR"] }],
    ["precedence", { paths: ["ADR.md"], precedence: "ADR" }],
  ])("rejects scalar %s at engine start before any step or write", async (_field, inputs) => {
    const t = await diskFixture([]);
    try {
      expect(() => t.engine.start({ workflow: builtinWorkflow("docs-synthesis")!, inputs })).toThrow(/not a valid array/);
      expect(t.db.prepare("SELECT COUNT(*) AS count FROM lane_pilot_wf_run").get()).toEqual({ count: 0 });
      expect(t.writes).toEqual([]);
    } finally { t.dispose(); }
  });
  it("rejects a scalar synth result at output validation before asking or writing", async () => {
    const t = await diskFixture("not an array");
    try {
      const started = t.start();
      const done = await started.done;
      expect(done.status).toBe("failed");
      expect(done.reason).toMatch(/output_invalid:synth/);
      expect(t.engine.get(started.runId)?.waiting).toEqual([]);
      expect(t.writes).toEqual([]);
      expect(readFileSync(join(t.checkout, "ADR.md"), "utf8")).toBe("one\n");
      expect(readFileSync(join(t.checkout, "PRD.md"), "utf8")).toBe("line\ntwo\n");
    } finally { t.dispose(); }
  });

  it("refuses malformed conflict before human or any write", async () => {
    const t = await diskFixture([{ ...conflict, b_quote: "" }]);
    try {
      const started = t.start(); const done = await started.done;
      expect(done.status).toBe("failed");
      expect(t.writes).toEqual([]);
      expect(t.engine.get(started.runId)?.waiting).toEqual([]);
      expect(readFileSync(join(t.checkout, "ADR.md"), "utf8")).toBe("one\n");
    } finally { t.dispose(); }
  });
  it("persists both sides, keeps originals and handles a real timeout as open", async () => {
    const t = await diskFixture([{ ...conflict, winner: "none", rule: "none" }]);
    try {
      const started = t.start();
      await t.engine.idle();
      expect(t.engine.get(started.runId)).toMatchObject({ status: "waiting" });
      expect(t.writes).toEqual([]);
      t.advance(901_000);
      await t.engine.poll(); await t.engine.idle();
      const done = t.engine.get(started.runId)!;
      expect(done, JSON.stringify(done)).toMatchObject({ status: "succeeded", output: { status: "open" } });
      const output = done.output as { markdown_path: string; json_path: string };
      expect(output.markdown_path).toBe(`.agents/planning/ingest/INGEST-CONFLICTS-${started.runId}.md`);
      expect(output.json_path).toBe(`.agents/planning/ingest/INGEST-CONFLICT-RECORDS-${started.runId}.json`);
      const rows = t.db.prepare("SELECT repo_path, node_id, producer_json FROM lane_pilot_run_file WHERE run_id=? ORDER BY rowid").all(started.runId) as Array<{ repo_path: string; node_id: string; producer_json: string }>;
      expect(rows.map((row) => [row.repo_path, row.node_id])).toEqual([[output.markdown_path, "write_md"], [output.json_path, "write_json"]]);
      expect(rows.map((row) => JSON.parse(row.producer_json))).toMatchObject([{ node: "write_md", graph: "docs-synthesis", run_id: started.runId }, { node: "write_json", graph: "docs-synthesis", run_id: started.runId }]);
      const md = readFileSync(join(t.checkout, output.markdown_path), "utf8");
      const jsonText = readFileSync(join(t.checkout, output.json_path), "utf8");
      const json = JSON.parse(jsonText);
      const artifacts = t.db.prepare("SELECT artifact_id, rel_path, producer_wf, producer_run_id, sha256 FROM lane_pilot_artifact WHERE project_id=? ORDER BY rel_path").all("project") as Array<{ artifact_id: string; rel_path: string; producer_wf: string; producer_run_id: string; sha256: string }>;
      expect(artifacts).toHaveLength(2);
      expect(new Set(artifacts.map((row) => row.artifact_id)).size).toBe(2);
      expect(artifacts.map(({ rel_path, producer_wf, producer_run_id, sha256 }) => ({ rel_path, producer_wf, producer_run_id, sha256 }))).toEqual([
        { rel_path: output.json_path, producer_wf: "docs-synthesis", producer_run_id: started.runId, sha256: sha256Hex(jsonText) },
        { rel_path: output.markdown_path, producer_wf: "docs-synthesis", producer_run_id: started.runId, sha256: sha256Hex(md) },
      ]);
      const manifest = JSON.parse(readFileSync(join(t.checkout, ".agents/manifest.json"), "utf8"));
      expect(manifest.count).toBe(2);
      expect(manifest.artifacts.map((entry: { artifact_id: string; rel_path: string; sha256: string }) => ({ artifact_id: entry.artifact_id, rel_path: entry.rel_path, sha256: entry.sha256 })).sort((a: { rel_path: string }, b: { rel_path: string }) => a.rel_path.localeCompare(b.rel_path))).toEqual(artifacts.map(({ artifact_id, rel_path, sha256 }) => ({ artifact_id, rel_path, sha256 })));
      expect(md).toContain("ADR.md"); expect(md).toContain("PRD.md");
      expect(json).toMatchObject([{ a_path: "ADR.md", a_line: 1, a_quote: "one", b_path: "PRD.md", b_line: 2, b_quote: "two" }]);
      expect(readFileSync(join(t.checkout, "ADR.md"), "utf8")).toBe("one\n");
      expect(readFileSync(join(t.checkout, "PRD.md"), "utf8")).toBe("line\ntwo\n");
      expect(t.writes).toEqual([
        join(t.checkout, output.markdown_path),
        join(t.checkout, ".agents/manifest.json"),
        join(t.checkout, `.agents/runs/${started.runId}/manifest.json`),
        join(t.checkout, output.json_path),
        join(t.checkout, ".agents/manifest.json"),
        join(t.checkout, `.agents/runs/${started.runId}/manifest.json`),
      ]);
    } finally { t.dispose(); }
  });
  it("does not overwrite an existing report or its sibling", async () => {
    const t = await diskFixture([conflict]);
    try {
      const started = t.start();
      const dir = join(t.checkout, ".agents/planning/ingest");
      mkdirSync(dir, { recursive: true });
      const original = join(dir, `INGEST-CONFLICTS-${started.runId}.md`);
      const sibling = join(dir, `INGEST-CONFLICTS-${started.runId}.new.md`);
      writeFileSync(original, "existing report"); writeFileSync(sibling, "existing sibling");
      const done = await started.done;
      expect(done.status).toBe("failed");
      expect(readFileSync(original, "utf8")).toBe("existing report");
      expect(readFileSync(sibling, "utf8")).toBe("existing sibling");
      expect(t.writes).toEqual([]);
      expect(readFileSync(join(t.checkout, "ADR.md"), "utf8")).toBe("one\n");
      expect(readFileSync(join(t.checkout, "PRD.md"), "utf8")).toBe("line\ntwo\n");
    } finally { t.dispose(); }
  });

  it("records an explicit owner choice and raw words while staying open", async () => {
    const t = await diskFixture([{ ...conflict, winner: "none", rule: "none" }]);
    try {
      const started = t.start();
      await t.engine.idle();
      const waiting = t.engine.get(started.runId)!;
      expect(waiting.status).toBe("waiting");
      const node = builtinWorkflow("docs-synthesis")!.nodes.find((item) => item.id === "resolve")!;
      if (node.type !== "human") throw new Error("expected human node");
      const answer = humanOutput(node, { choiceIndex: 1, text: "  use ADR, after review  " });
      expect(answer).toMatchObject({ answer_kind: "decided", answer: "  use ADR, after review  " });
      expect(await t.engine.resolve(started.runId, waiting.waiting[0]!.stepKey, answer!)).toBe(true);
      await t.engine.idle();
      const done = t.engine.get(started.runId)!;
      expect(done, JSON.stringify(done)).toMatchObject({ status: "succeeded", output: { status: "open", owner_response: "decided" } });
      const output = done.output as { markdown_path: string; json_path: string };
      const md = readFileSync(join(t.checkout, output.markdown_path), "utf8");
      expect(md).toContain("  use ADR, after review  ");
      expect(md).toContain("ADR.md"); expect(md).toContain("PRD.md");
      expect(JSON.parse(readFileSync(join(t.checkout, output.json_path), "utf8"))).toMatchObject([{ a_quote: "one", b_quote: "two", auto_resolved: false }]);
      expect(readFileSync(join(t.checkout, "ADR.md"), "utf8")).toBe("one\n");
      expect(readFileSync(join(t.checkout, "PRD.md"), "utf8")).toBe("line\ntwo\n");
    } finally { t.dispose(); }
  });

});
