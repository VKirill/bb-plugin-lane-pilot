import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../../src/contracts";
import { ARTIFACTS, artifactDef, artifactExample, artifactId, checkProduces, parseArtifactId, summarizeValue, validateArtifact } from "../../src/rooms/workflow/artifacts";

/** The registry of artifact kinds (W0): a schema and an example per kind, and the check of a step's output against them. */
describe("the artifact registry", () => {
  it("has the kinds the chains name, once each", () => {
    const ids = ARTIFACTS.map(artifactId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["plan/1", "task/2", "verdict/1", "findings/1", "search-results/1", "summary/1", "qa-report/1", "post-draft/1", "invoice/1", "verification/1", "report/1"]) expect(ids).toContain(id);
  });

  it("every example is valid for its own schema, carries the keys the kind says it needs, and an empty object is refused", () => {
    for (const def of ARTIFACTS) {
      const result = validateArtifact(def.kind, def.version, def.example);
      expect(result, artifactId(def) + " example").toMatchObject({ ok: true });
      for (const key of def.required) expect(def.example, `${artifactId(def)} example has ${key}`).toHaveProperty(key);
      expect(validateArtifact(def.kind, def.version, {}).ok, `${artifactId(def)} accepts {}`).toBe(false);
      expect(artifactExample(def.kind, def.version).length).toBeGreaterThan(10);
    }
  });

  it("task/2 is the writer's task contract: the same schema, with convergence.criteria and files[]", () => {
    expect(artifactDef("task", 2)!.schema).toBe(taskV2Schema);
    const example = artifactDef("task", 2)!.example as Record<string, unknown>;
    expect(example).toHaveProperty("convergence.criteria");
    expect(example).toHaveProperty("files");
    const { objective: _objective, ...broken } = example;
    const result = validateArtifact("task", 2, broken);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(" ")).toContain("objective");
  });

  it("names the path and the problem, and refuses a kind or version it does not know", () => {
    const bad = validateArtifact("verdict", 1, { status: "maybe", findings: [{ severity: "urgent", title: "x" }, { severity: "high" }] });
    expect(bad.ok).toBe(false);
    const text = !bad.ok ? bad.errors.join("\n") : "";
    expect(text).toContain("status");
    expect(text).toContain("findings.0.severity");
    expect(text).toContain("findings.1");
    expect(text).toContain("title, a description or quoted evidence");
    expect(validateArtifact("verdict", 2, {})).toEqual({ ok: false, errors: ["unknown artifact kind verdict/2"] });
    expect(validateArtifact("poem", 1, {})).toMatchObject({ ok: false });
  });

  it("is open: fields beyond the kind's are kept", () => {
    const result = validateArtifact("summary", 1, { summary: "s", extra: [1] });
    expect(result).toEqual({ ok: true, value: { summary: "s", extra: [1] } });
  });

  it("some kinds carry a rule of their own: a done invoice has a number and a PDF; the three layers of a verification are lists", () => {
    expect(validateArtifact("invoice", 1, { status: "done", invoice_number: "1", pdf_path: "a.pdf" }).ok).toBe(true);
    expect(validateArtifact("invoice", 1, { status: "client_not_found", reason: "no client" }).ok).toBe(true);
    expect(validateArtifact("invoice", 1, { status: "done" }).ok).toBe(false);
    const verification = artifactDef("verification", 1)!.example as Record<string, unknown>;
    expect(validateArtifact("verification", 1, { ...verification, layer3_wiring: "yes" }).ok).toBe(false);
    expect(validateArtifact("verification", 1, { ...verification, gaps: [{ id: "G", type: "mood", severity: "high", description: "d", source: "layer1" }] }).ok).toBe(false);
  });

  it("parses ids", () => {
    expect(parseArtifactId("plan/1")).toEqual({ kind: "plan", version: 1 });
    expect(parseArtifactId("search-results/12")).toEqual({ kind: "search-results", version: 12 });
    expect(parseArtifactId("plan")).toBeNull();
    expect(parseArtifactId("Plan/1")).toBeNull();
    expect(parseArtifactId("plan/0")).toBeNull();
  });
});

describe("a step's output against what it produces", () => {
  const findingsOut = { findings: [{ severity: "high", title: "t" }], handoff: "h" };
  it("the whole output is the artifact when no field is named", () => {
    expect(checkProduces([{ kind: "findings", version: 1 }], findingsOut)).toEqual([]);
    const problems = checkProduces([{ kind: "findings", version: 1 }], { findings: [{ title: "no severity" }], handoff: "h" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("findings/1 output: findings.0.severity");
  });

  it("a field holds the artifact, or a list of them with each", () => {
    const task = artifactDef("task", 2)!.example;
    expect(checkProduces([{ kind: "task", version: 2, field: "contract" }], { contract: task })).toEqual([]);
    expect(checkProduces([{ kind: "task", version: 2, field: "tasks", each: true }], { tasks: [task, task] })).toEqual([]);
    const bad = checkProduces([{ kind: "task", version: 2, field: "tasks", each: true }], { tasks: [task, { id: "T2" }] });
    expect(bad[0]).toContain("task/2 tasks[1]:");
    expect(checkProduces([{ kind: "task", version: 2, field: "tasks", each: true }], { tasks: task })[0]).toContain("must be a list of task/2");
  });

  it("a missing field is a problem unless the artifact is optional", () => {
    expect(checkProduces([{ kind: "plan", version: 1, field: "plan" }], {})).toEqual(['plan/1: the field "plan" is missing']);
    expect(checkProduces([{ kind: "plan", version: 1, field: "plan", required: false }], {})).toEqual([]);
  });

  it("several artifacts of one step are all checked", () => {
    const problems = checkProduces([{ kind: "summary", version: 1, field: "a" }, { kind: "summary", version: 1, field: "b" }], { a: { summary: "ok" }, b: { nope: 1 } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("summary/1 b: summary");
  });
});

describe("the summary that stands in for a value", () => {
  it("is one or two short lines: the lead text, the counts of lists, the short scalars", () => {
    expect(summarizeValue({ summary: "Three entry points.", findings: [1, 2, 3], status: "pass", blob: "x".repeat(500) })).toBe("Three entry points.; findings: 3; status: pass");
    expect(summarizeValue([{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }])).toBe("list of 4: A; B; C; ...");
    expect(summarizeValue("a\n\n  long   text ".repeat(40), 60).length).toBeLessThanOrEqual(60);
    expect(summarizeValue(7)).toBe("7");
    expect(summarizeValue({})).toBe("object with 0 keys");
  });
});
