import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEDUPE_THRESHOLD,
  createDraftStore,
  graphSignature,
  jaccard,
  nearestByStructure,
  traceSignature,
  type RawDefinition,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import { migrations } from "../../src/rooms/migrations";
import {
  DEFAULT_PATHS_DEDUPE_THRESHOLD,
  PATHS_DEDUPE_THRESHOLD_KEY,
  parseLeadSettings,
} from "../../src/rooms/lead/settings";
import { createDedupeGate } from "../../src/rooms/workflow/server/services/dedupe-gate";
import { createWorkflowArchitect, type ArchitectDeps } from "../../src/rooms/workflow/server/services/workflow-architect";
import { createWorkflowRoom } from "../../src/rooms/workflow/server/room";

function makeDefinition(
  id: string,
  steps: Array<{ id: string; type: "agent" | "action" | "subworkflow"; role?: string; uses?: string; action?: string; workflow?: string; effect?: string }>,
  extra: Partial<RawDefinition> = {},
): RawDefinition {
  const nodes: Record<string, unknown>[] = steps.map((step) => ({ ...step }));
  const edges: Array<{ from: string; to: string }> = [];
  if (steps.length > 0) {
    edges.push({ from: "start", to: steps[0]!.id });
    for (let i = 0; i < steps.length - 1; i += 1) {
      edges.push({ from: steps[i]!.id, to: steps[i + 1]!.id });
    }
    edges.push({ from: steps[steps.length - 1]!.id, to: "end" });
  }
  return {
    id,
    version: 1,
    name: { en: id, ru: id },
    description: { en: `Workflow ${id}`, ru: `Workflow ${id}` },
    scope: { level: "global" },
    status: "published",
    inputs: [],
    outputs: [],
    requires: {},
    nodes,
    edges,
    ...extra,
  } as RawDefinition;
}

function makeWorkflow(
  id: string,
  steps: Array<{ id: string; type: "agent" | "action" | "subworkflow"; role?: string; uses?: string; action?: string; workflow?: string; effect?: string }>,
  opts: { scope?: { level: "global" | "project"; projectId?: string }; status?: "published" | "draft" | "deprecated"; internal?: boolean } = {},
): Workflow {
  return {
    ...makeDefinition(id, steps, {
      scope: opts.scope ?? { level: "global" },
      status: opts.status ?? "published",
      ...(opts.internal ? { internal: true } : {}),
    }),
  } as unknown as Workflow;
}

function setupArchitect(opts: {
  threshold?: number | (() => number);
  library?: Workflow[];
} = {}) {
  const logs: string[] = [];
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const ctx = {
    bb: { log: { debug: (msg: string) => logs.push(msg) } },
    db,
    log: (msg: string) => logs.push(msg),
    realtime: { notify: () => undefined },
  } as never;

  const deps: ArchitectDeps = {
    globalDir: () => "/tmp/lp-global-workflows",
    projectPlace: async () => null,
    writeProjectFile: async () => ({ status: "applied", path: "/tmp/x.json", afterSha256: "abc", reason: null }),
    capabilityPorts: () => ({} as ReturnType<ArchitectDeps["capabilityPorts"]>),
    hasExecutor: () => true,
    dedupeThreshold: opts.threshold,
    loadLibraryWorkflows: async () => opts.library ?? [],
  };

  const architect = createWorkflowArchitect(ctx, { workflowEngine: { hasExecutor: () => true } } as never, deps);
  return { db, drafts: createDraftStore(db), architect, logs };
}

describe("structural workflow deduplication", () => {
  it("computes structural graphSignature and traceSignature with effect and Jaccard distance", () => {
    const def = makeDefinition("sample", [
      { id: "plan", type: "agent", role: "planner", effect: "read" },
      { id: "lint", type: "action", uses: "shell:lint" },
      { id: "sub", type: "subworkflow", workflow: "verify-loop", effect: "verify" },
      { id: "n1", type: "agent", role: "note" } as never,
    ]);
    // Replace last node cleanly with a note node to verify notes are ignored
    (def.nodes as Record<string, unknown>[])[3] = { id: "memo", type: "note", text: "ignore me" };

    const gSig = graphSignature(def);
    expect([...gSig].sort()).toEqual([
      "action:shell:lint:-",
      "agent:planner:read",
      "subworkflow:verify-loop:verify",
    ]);

    const tSig = traceSignature([
      "agent:planner:read",
      "action:shell:lint",
      "subworkflow:verify-loop:verify",
    ]);
    expect(jaccard(gSig, tSig)).toBe(1);

    const best = nearestByStructure(gSig, [
      { id: "draft-low", sig: new Set(["agent:planner:read"]), status: "draft" },
      { id: "pub-match", sig: tSig, status: "published" },
    ]);
    expect(best).toEqual({ id: "pub-match", score: 1 });
  });

  it("refuses identical workflow structures (score 1.0 -> near_twin) and logs decision", async () => {
    const existing = makeWorkflow("existing-fix", [
      { id: "s1", type: "agent", role: "researcher" },
      { id: "s2", type: "agent", role: "writer" },
      { id: "s3", type: "action", uses: "builtin:verify" },
    ]);
    const { architect, drafts, logs } = setupArchitect({ library: [existing] });

    const candidateDef = makeDefinition("candidate-fix", [
      { id: "a", type: "agent", role: "researcher" },
      { id: "b", type: "agent", role: "writer" },
      { id: "c", type: "action", uses: "builtin:verify" },
    ]);

    const res = await architect.createFrom({
      projectId: "proj-1",
      scope: "global",
      workflowId: "candidate-fix",
      definition: candidateDef,
      name: { en: "Candidate Fix", ru: "Candidate Fix" },
      description: { en: "Twin of existing-fix", ru: "Twin" },
      dedupe: true,
    });

    expect(res).toMatchObject({
      ok: false,
      reason: "near_twin",
      workflowId: "existing-fix",
      score: 1,
      threshold: DEFAULT_DEDUPE_THRESHOLD,
      outcome: "near_twin",
    });
    expect(drafts.list("proj-1")).toHaveLength(0);
    expect(logs.some((line) => line === "dedupe best=existing-fix score=1.000 threshold=0.8 outcome=near_twin")).toBe(true);
  });

  it("allows a graph with one extra step below default 0.8 (score 0.75) and records pass metadata", async () => {
    const existing = makeWorkflow("three-step", [
      { id: "s1", type: "agent", role: "researcher" },
      { id: "s2", type: "agent", role: "writer" },
      { id: "s3", type: "action", uses: "builtin:verify" },
    ]);
    const { architect, drafts, logs } = setupArchitect({ library: [existing] });

    const extendedDef = makeDefinition("four-step", [
      { id: "a", type: "agent", role: "researcher" },
      { id: "b", type: "agent", role: "writer" },
      { id: "c", type: "action", uses: "builtin:verify" },
      { id: "d", type: "agent", role: "reviewer" },
    ]);

    const draft = await architect.createFrom({
      projectId: "proj-1",
      scope: "global",
      workflowId: "four-step",
      definition: extendedDef,
      name: { en: "Four step", ru: "Four step" },
      description: { en: "Three plus reviewer", ru: "Three plus reviewer" },
      dedupe: true,
    });

    expect("id" in draft).toBe(true);
    if (!("id" in draft)) throw new Error("expected draft");
    expect(draft.metadata?.dedupe).toMatchObject({
      id: "three-step",
      score: 0.75,
      threshold: 0.8,
      outcome: "pass",
      at: expect.any(Number),
    });
    expect(drafts.get(draft.id)?.metadata?.dedupe).toMatchObject({
      id: "three-step",
      score: 0.75,
      threshold: 0.8,
      outcome: "pass",
      at: expect.any(Number),
    });
    expect(logs.some((line) => line === "dedupe best=three-step score=0.750 threshold=0.8 outcome=pass")).toBe(true);
  });

  it("honors paths.dedupe_threshold setting and refuses 0.75 when threshold is lowered to 0.7", async () => {
    expect(PATHS_DEDUPE_THRESHOLD_KEY).toBe("paths.dedupe_threshold");
    expect(DEFAULT_PATHS_DEDUPE_THRESHOLD).toBe(DEFAULT_DEDUPE_THRESHOLD);
    expect(parseLeadSettings({}).dedupeThreshold).toBe(0.8);
    expect(parseLeadSettings({ [PATHS_DEDUPE_THRESHOLD_KEY]: 0.7 }).dedupeThreshold).toBe(0.7);

    const existing = makeWorkflow("three-step", [
      { id: "s1", type: "agent", role: "researcher" },
      { id: "s2", type: "agent", role: "writer" },
      { id: "s3", type: "action", uses: "builtin:verify" },
    ]);
    const { architect } = setupArchitect({
      threshold: parseLeadSettings({ [PATHS_DEDUPE_THRESHOLD_KEY]: 0.7 }).dedupeThreshold,
      library: [existing],
    });

    const extendedDef = makeDefinition("four-step", [
      { id: "a", type: "agent", role: "researcher" },
      { id: "b", type: "agent", role: "writer" },
      { id: "c", type: "action", uses: "builtin:verify" },
      { id: "d", type: "agent", role: "reviewer" },
    ]);

    const refused = await architect.createFrom({
      projectId: "proj-1",
      scope: "global",
      workflowId: "four-step",
      definition: extendedDef,
      name: { en: "Four step", ru: "Four step" },
      description: { en: "Three plus reviewer", ru: "Three plus reviewer" },
      dedupe: true,
    });
    expect(refused).toMatchObject({ ok: false, reason: "near_twin", workflowId: "three-step", score: 0.75 });
  });

  it("counts pending drafts and internal graphs in the same scope as candidates while isolating other projects", async () => {
    const internalWf = makeWorkflow(
      "internal-sync",
      [
        { id: "a", type: "action", uses: "sync:fetch" },
        { id: "b", type: "action", uses: "sync:apply" },
      ],
      { internal: true, scope: { level: "project", projectId: "proj-1" } },
    );
    const { architect, drafts } = setupArchitect({ library: [internalWf] });

    // Create a pending project draft manually first
    const pendingDef = makeDefinition("pending-path", [
      { id: "n1", type: "agent", role: "triage" },
      { id: "n2", type: "action", uses: "ticket:label" },
    ], { scope: { level: "project", projectId: "proj-1" } });
    drafts.create({
      projectId: "proj-1",
      threadId: "thr_1",
      scope: "project",
      name: "Pending path",
      description: "Pending candidate",
      workflowId: "pending-path",
      definition: pendingDef,
    });

    // Twin of pending draft in same project is refused (via architect.create + dedupe: true)
    const refusedPending = await architect.create({
      projectId: "proj-1",
      threadId: "thr_2",
      scope: "project",
      name: "Duplicate pending",
      description: "Matches pending-path",
      workflowId: "dup-pending",
      definition: pendingDef,
      dedupe: true,
    });
    expect(refusedPending).toMatchObject({ ok: false, reason: "near_twin", workflowId: "pending-path", score: 1 });

    // Twin of internal workflow in same project is refused
    const refusedInternal = await architect.create({
      projectId: "proj-1",
      threadId: "thr_3",
      scope: "project",
      name: "Dup internal",
      description: "Matches internal-sync",
      workflowId: "dup-internal",
      trace: ["action:sync:fetch", "action:sync:apply"],
      dedupe: true,
    });
    expect(refusedInternal).toMatchObject({ ok: false, reason: "near_twin", workflowId: "internal-sync", score: 1 });

    // Project scope draft in a DIFFERENT project passes (not collided with proj-1 project candidates)
    const otherProj = await architect.create({
      projectId: "proj-2",
      threadId: "thr_4",
      scope: "project",
      name: "Separate project flow",
      description: "Own project scope",
      workflowId: "separate-pending",
      definition: pendingDef,
      dedupe: true,
    });
    expect("draftId" in otherProj).toBe(true);
    if (!("draftId" in otherProj)) throw new Error("expected draft result");
    expect(otherProj.metadata?.dedupe).toMatchObject({ outcome: "pass", threshold: 0.8 });
  });

  it("exempts branch drafts of the very graph they branch from", async () => {
    const parent = makeWorkflow("base-loop", [
      { id: "p1", type: "agent", role: "planner" },
      { id: "p2", type: "agent", role: "coder" },
    ]);
    const { architect } = setupArchitect({ library: [parent] });

    const branchDraft = await architect.createFrom({
      projectId: "proj-1",
      scope: "global",
      workflowId: "base-loop-branch",
      definition: makeDefinition("base-loop-branch", [
        { id: "p1", type: "agent", role: "planner" },
        { id: "p2", type: "agent", role: "coder" },
      ]),
      name: { en: "Base Loop Branch", ru: "Base Loop Branch" },
      description: { en: "Branch of base-loop", ru: "Branch" },
      branchOf: "base-loop",
      dedupe: true,
    });

    expect("id" in branchDraft).toBe(true);
    if (!("id" in branchDraft)) throw new Error("expected branch draft");
    expect(branchDraft.metadata?.branchOf).toBe("base-loop");
    expect(branchDraft.metadata?.dedupe).toMatchObject({
      id: null,
      score: 0,
      threshold: 0.8,
      outcome: "pass",
      at: expect.any(Number),
    });

    // Direct createDedupeGate + workflow room mount parameter smoke check
    const room = createWorkflowRoom({ dedupeThreshold: 0.9 });
    expect(room.name).toBe("workflow");
    const gate = createDedupeGate({ threshold: 0.9 });
    const passCheck = await gate.check({
      scope: "global",
      projectId: "proj-1",
      trace: ["agent:novel-role"],
    });
    expect(passCheck.ok).toBe(true);
  });
});
