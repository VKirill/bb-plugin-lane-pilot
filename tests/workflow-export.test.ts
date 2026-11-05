import { describeStep } from "../src/rooms/workflow/step-describe";
import { describe, expect, it } from "vitest";
import { parseWorkflowObject, type Workflow } from "@lane-pilot/workflow-engine";
import { BUILTIN_SOURCES } from "../src/rooms/workflow/builtin";
import { buildWorkflowExport, redactDefinition, selectExportEntries, type WorkflowExportEntry } from "../src/rooms/workflow/workflow-export";

const builtinEntries = (): WorkflowExportEntry[] =>
  BUILTIN_SOURCES.map((source) => {
    const parsed = parseWorkflowObject(source.value);
    if (!parsed.success) throw new Error(`builtin ${source.name} does not parse`);
    return { definition: source.value as Record<string, unknown>, workflow: parsed.data as Workflow, scope: "builtin" as const };
  });

describe("workflow export redaction", () => {
  it("blanks secret names, host ids and filesystem paths", () => {
    const definition = {
      requires: { secrets: ["TAVILY_API_KEY", "OPTIONAL_ONE?"], machines: ["host_mini2"], tools: ["~/toolkit/telegram/tg"] },
      nodes: [{ id: "a", type: "agent", role: "x", prompt: "Read /home/ubuntu/BB-service/file.txt and ~/notes/x.md on host_o47u, then env_get {{secret:TAVILY_API_KEY}}; also permission secret:MAIL_LOGIN." }],
    };
    const redacted = redactDefinition(definition) as typeof definition;
    expect(redacted.requires.secrets).toEqual(["<secret>", "<secret>"]);
    expect(redacted.requires.machines).toEqual(["<host>"]);
    expect(redacted.requires.tools).toEqual(["<path>"]);
    const prompt = redacted.nodes[0].prompt;
    expect(prompt).not.toContain("/home/ubuntu");
    expect(prompt).not.toContain("~/notes");
    expect(prompt).not.toContain("host_o47u");
    expect(prompt).not.toContain("TAVILY_API_KEY");
    expect(prompt).not.toContain("MAIL_LOGIN");
    expect(prompt).toContain("<path>");
    expect(prompt).toContain("<secret>");
  });

  it("leaves ordinary text and urls alone", () => {
    const definition = { a: "fetch https://example.com/docs/api then post", b: "release/notes.md" };
    expect(redactDefinition(definition)).toEqual(definition);
  });
});

describe("workflow export selection", () => {
  const entries = builtinEntries();
  it("takes everything by default, a shelf by category, chosen rows by ids", () => {
    expect(selectExportEntries(entries, {}).length).toBe(entries.length);
    const seo = selectExportEntries(entries, { category: "seo" });
    expect(seo.length).toBeGreaterThan(0);
    expect(seo.every((entry) => entry.workflow.id.startsWith("seo-") || entry.workflow.tags.includes("seo"))).toBe(true);
    const ids = selectExportEntries(entries, { ids: [seo[0].workflow.id, "errand"] });
    expect(ids.map((entry) => entry.workflow.id).sort()).toEqual([seo[0].workflow.id, "errand"].sort());
  });

  it("drops project-scope graphs unless asked", () => {
    const mixed: WorkflowExportEntry[] = [...entries.slice(0, 2), { definition: {}, workflow: entries[0].workflow, scope: "project" }];
    expect(selectExportEntries(mixed, {}).some((entry) => entry.scope === "project")).toBe(false);
    expect(selectExportEntries(mixed, { includeProjectGraphs: true }).some((entry) => entry.scope === "project")).toBe(true);
  });
});

describe("workflow export build", () => {
  it("exports a real built-in file that parses back with the loader's schema", () => {
    const entries = builtinEntries();
    const result = buildWorkflowExport({ entries, ids: ["telegram-send"], redact: true, version: "0.0.0-test", commit: null, now: new Date(0) });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("workflows/telegram-send.json");
    const parsed = parseWorkflowObject(JSON.parse(result.files[0].text));
    expect(parsed.success).toBe(true);
    expect(result.manifest.graphs).toEqual([{ id: "telegram-send", version: 1, category: "content", scope: "builtin" }]);
    expect(result.manifest.redacted).toBe(true);
  });

  it("redacts nothing when asked not to", () => {
    const entries = builtinEntries();
    const raw = JSON.stringify(entries.find((entry) => entry.workflow.id === "errand")!.definition, null, 2);
    const result = buildWorkflowExport({ entries, ids: ["errand"], redact: false, version: "x", commit: "abc", now: new Date(0) });
    expect(result.files[0].text.trim()).toBe(raw);
    expect(result.manifest.redacted).toBe(false);
    expect(result.manifest.commit).toBe("abc");
  });

  it("writes a readable markdown overview per category with steps in order", () => {
    const entries = builtinEntries();
    const result = buildWorkflowExport({ entries, ids: ["analyze-plan-execute"], redact: true, version: "x", commit: null, now: new Date(0) });
    const workflow = entries.find((entry) => entry.workflow.id === "analyze-plan-execute")!.workflow;
    expect(result.markdown).toContain("## code");
    expect(result.markdown).toContain(workflow.name.ru);
    expect(result.markdown).toContain("`analyze-plan-execute`");
    // Every step is described in full, so the file alone is enough to hand to an agent.
    expect(result.markdown).toContain("Как читать этот файл");
    for (const node of workflow.nodes) {
      if (node.type === "note") continue;
      expect(result.markdown).toContain(`(\`${node.id}\`)`);
      if (node.type === "agent" && node.prompt) expect(result.markdown).toContain(node.prompt.split("\n")[0]!.slice(0, 60));
    }
    expect(result.markdown).toContain("**Дальше:**");
  });
});

describe("describeStep", () => {
  it("names the step's task, skills, sources and next steps; a subworkflow names the graph it calls", () => {
    const cocoon = builtinEntries().find((entry) => entry.workflow.id === "seo-cocoon")!.definition;
    const nodes = cocoon.nodes as Array<Record<string, unknown>>;
    const call = nodes.find((node) => node.type === "subworkflow")!;
    const facts = describeStep(cocoon, String(call.id));
    expect(facts.find((fact) => fact.label === "Вызывает граф")?.value).toBe(call.workflow);
    expect(facts.some((fact) => fact.label === "Получает")).toBe(true);
    expect(facts.some((fact) => fact.label === "Дальше")).toBe(true);
    const agent = nodes.find((node) => node.type === "agent" && node.prompt)!;
    expect(describeStep(cocoon, String(agent.id)).find((fact) => fact.label === "Задание")?.value).toBe(agent.prompt);
  });
});
