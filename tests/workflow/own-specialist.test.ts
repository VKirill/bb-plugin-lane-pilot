import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { collectCapabilities, parseWorkflow, validateWorkflow } from "@lane-pilot/workflow-engine";
import { roleSpec } from "../../src/rooms/workflow/server/workflow-agent";
import { createWorkflowArchitect } from "../../src/rooms/workflow/server/workflow-architect";
import type { ArchitectDeps } from "../../src/rooms/workflow/server/workflow-architect";
import type { Services } from "../../src/rooms/core/server/services";
import { migrations } from "../../src/rooms/storage/database";

/** A node `role: "specialist:<id>"` names any bundled specialist or agent the owner created; one that does not exist fails validation. */
const workflow = (role: string) => parseWorkflow({
  schemaVersion: 1, id: "own-specialist", name: "Own specialist", description: { en: "A chain", ru: "Цепочка" }, inputs: [], outputs: [],
  nodes: [{ id: "write", type: "agent", role, prompt: "Write the post.", out: [{ name: "text", type: "string" }] }],
  edges: [{ from: "start", to: "write" }, { from: "write", to: "end" }],
});
const problems = (role: string, known: (id: string) => boolean | null) => validateWorkflow(workflow(role), { specialistKnown: known }).filter((row) => row.code === "unknown_specialist");
const known = (id: string) => ["seo-specialist", "blog-writer"].includes(id);

describe("roleSpec for an agent the owner created", () => {
  it("is a specialist helper under its own id, like a bundled one; a bundled agent that is no specialist stays an analyst", () => {
    expect(roleSpec("specialist:blog-writer")).toMatchObject({ helper: "specialist:blog-writer", metadata: "specialist", specialist: "blog-writer", readOnly: false });
    expect(roleSpec("specialist:blog-writer").editable(".agents/posts/a.md")).toBe(true);
    expect(roleSpec("specialist:blog-writer").editable("src/a.ts")).toBe(false);
    expect(roleSpec("specialist:seo-specialist")).toMatchObject({ specialist: "seo-specialist" });
    for (const role of ["specialist:dev-orchestrator", "specialist:", "specialist:Bad Id"]) expect(roleSpec(role), role).toMatchObject({ helper: "analyst", readOnly: true });
  });
});

describe("the validator and a node that names an agent", () => {
  it("accepts a bundled specialist and an agent that exists, and refuses one that does not, naming it", () => {
    expect(problems("specialist:seo-specialist", known)).toEqual([]);
    expect(problems("specialist:blog-writer", known)).toEqual([]);
    const [problem] = problems("specialist:ghost-writer", known);
    expect(problem).toMatchObject({ level: "error", node: "write", message: expect.stringContaining('"ghost-writer" is neither a bundled specialist nor an agent you created') });
  });

  it("says nothing when it cannot know yet, and for a role that is not a specialist", () => {
    expect(problems("specialist:ghost-writer", () => null)).toEqual([]);
    expect(problems("analyst", () => false)).toEqual([]);
    expect(validateWorkflow(workflow("specialist:ghost-writer")).filter((row) => row.code === "unknown_specialist")).toEqual([]);
  });
});

describe("the capabilities list of specialists", () => {
  it("takes a list or a lookup, so the owner's agents are named to the architect", async () => {
    expect(await collectCapabilities({ specialists: ["design-lead"] }, { sections: ["specialists"] })).toMatchObject({ specialists: { roles: ["design-lead"] } });
    const result = await collectCapabilities({ specialists: async () => ["design-lead", "blog-writer"] }, { sections: ["specialists"] }) as { specialists: { roles: string[]; note: string } };
    expect(result.specialists.roles).toEqual(["design-lead", "blog-writer"]);
    expect(result.specialists.note).toContain("specialist:<id>");
    expect(await collectCapabilities({ specialists: async () => { throw new Error("kv is down"); } }, { sections: ["specialists"] })).toMatchObject({ specialists: { status: "error", error: "kv is down" } });
  });
});

describe("a draft in the Workflow architect", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  it("reports unknown_specialist for a node naming a missing agent, and clears it for one the owner has", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations);
    const globalDir = await mkdtemp(join(tmpdir(), "lp-own-specialist-"));
    dirs.push(globalDir);
    const deps: ArchitectDeps = {
      globalDir: () => globalDir, projectPlace: async () => null, writeProjectFile: async () => ({ status: "conflict", path: "", afterSha256: null, reason: "no machine" }), hasExecutor: () => true,
      capabilityPorts: () => ({ specialists: async () => ["design-lead", "blog-writer"] }), specialistKnown: (id) => id === "design-lead" || id === "blog-writer",
    };
    const architect = createWorkflowArchitect({ db, log: () => undefined, realtime: { notify: () => undefined } } as never, { workflowEngine: null } as unknown as Pick<Services, "workflowEngine">, deps);
    const draft = architect.drafts.create({ projectId: "p1", threadId: null, scope: "global", name: "Posts", description: "Write a post" });
    const node = (role: string) => ({ op: "add_node" as const, node: { id: "write", type: "agent", role, prompt: "Write the post.", out: [{ name: "text", type: "string" }] } });
    const missing = architect.patch({ projectId: "p1", draftId: draft.id, ops: [node("specialist:ghost-writer"), { op: "add_edge", edge: { from: "start", to: "write" } }, { op: "add_edge", edge: { from: "write", to: "end" } }] });
    expect(missing).toMatchObject({ ok: true, valid: false });
    expect(JSON.stringify((missing as { problems: unknown }).problems)).toContain("unknown_specialist");
    const fixed = architect.patch({ projectId: "p1", draftId: draft.id, ops: [{ op: "update_node", id: "write", set: { role: "specialist:blog-writer" } }] });
    expect(JSON.stringify((fixed as { problems: unknown }).problems)).not.toContain("unknown_specialist");
    expect((await architect.capabilities({ projectId: "p1", threadId: "t", sections: ["specialists"] }) as { specialists: { roles: string[] } }).specialists.roles).toContain("blog-writer");
  });
});
