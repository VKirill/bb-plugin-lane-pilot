import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertProjectArtifact, saveProjectSetting } from "../../src/rooms/plugin-db";
import { readRunFile, renderRunManifest, resolveLatestPointer, resolveRunFile } from "../../src/rooms/storage";
import { checkoutFileIo, deliverRunFile } from "../../src/rooms/workflow/server/workflow-run-home";
import { sha256Hex } from "@lane-pilot/kit";
import { PROJECT, chain, reply, runHomeWorld } from "./run-home-world";
import type { Row } from "./run-home-world";

/**
 * Step 2 of the hand-off standard (docs/task-folder.md, «The run folder»): one test per node → node transition of a workflow-graph run that the
 * standard changed. Each names the line to flip to see it red.
 */
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const files = (manifest: Record<string, unknown> | null) => (manifest?.files ?? []) as Array<{ path: string; kind: string; root: string; produced_by: { node: string; graph: string; run_id: string }; plugin_version: string; readers: string[]; read_by: Array<{ node: string; sha256: string }>; replaces?: string; sha256: string }>;
const agent = (id: string, extra: Row = {}) => ({ id, type: "agent", role: "analyst", prompt: `Work ${id}.`, output: [{ name: "n", type: "number" }], ...extra });

/** A date-style graph written the way the 15 date/slug graphs now are: a folder of its own per run, a consumer that is given the folder by the edge. */
const reportGraph = (pathTemplate: string) => chain({
  inputs: [{ name: "note", type: "string", required: false, default: "note" }],
  outputs: [{ name: "n", type: "number", required: false }],
  nodes: [
    { id: "put", type: "action", action: "fs.write", path: pathTemplate, contents: { "report.md": "report of {{run_id}}: {{$inputs.note}}" }, out: { report_path: "string" } },
    agent("use", { produces: [{ kind: "report", version: 1 }] }),
    { id: "done", type: "action", action: "emit", map: { n: "use.n" } },
  ],
  edges: [{ from: "start", to: "put" }, { from: "put", to: "use", with: { report_path: "put.report_path" } }, { from: "use", to: "done" }],
});
const promptOf = (spawned: Row[], at: number) => String(spawned[at]!.prompt);

describe("the run folder: fs.write → the next node", () => {
  // Flip: in workflow-checkout-actions.ts, drop the `await noteRunFiles(...)` line (the node's files never reach the run's manifest).
  it("R1 fs.write → consumer: each run's output is in ITS manifest, written by the node, and the consumer finds it by run, kind and node", async () => {
    const w = await runHomeWorld({ use: [reply({ n: 1, handoff: "h" })] });
    dispose = w.dispose;
    const summary = await w.start(reportGraph("reports/{{date}}-{{run_id}}/"), { note: "first" }).done;
    expect(summary.status).toBe("succeeded");
    const manifest = renderRunManifest(w.db, summary.runId)!;
    expect(manifest).toMatchObject({ schema: "lp.run-manifest/1", run_id: summary.runId, workflow_id: "run-home-chain", project_id: PROJECT });
    const [row] = files(manifest);
    expect(row).toMatchObject({ kind: "output", root: "checkout", produced_by: { node: "put", graph: "run-home-chain", run_id: summary.runId }, readers: ["use"] });
    expect(row!.path).toBe(`reports/${new Date().toISOString().slice(0, 10)}-${summary.runId}/report.md`);
    expect(row!.plugin_version).toMatch(/^\d+\.\d+\.\d+/);
    // The manifest file is the rendering of the rows, in the run's own folder.
    const onDisk = JSON.parse(readFileSync(join(w.checkout, `.agents/runs/${summary.runId}/manifest.json`), "utf8")) as Record<string, unknown>;
    expect(onDisk).toEqual(manifest);
    // The consumer asks the manifest, not the folder: its answer is this run's file, and the read lands in read_by.
    const read = await readRunFile(w.db, checkoutFileIo(w.ctx, { hostId: "local", path: w.checkout }), { runId: summary.runId, kind: "output", nodeId: "put", reader: "use" });
    expect(read?.text).toBe(`report of ${summary.runId}: first`);
    expect(read?.drift).toBe(false);
    expect(files(renderRunManifest(w.db, summary.runId))[0]!.read_by.map((who) => who.node)).toEqual(["use"]);
    // A neighbour run's id, another kind, or a node that wrote nothing resolves to nothing.
    expect(resolveRunFile(w.db, "wfrun_other", { kind: "output", nodeId: "put" })).toBeNull();
    expect(resolveRunFile(w.db, summary.runId, { kind: "latest-pointer", nodeId: "put" })).toBeNull();
    expect(resolveRunFile(w.db, summary.runId, { kind: "output", nodeId: "use" })).toBeNull();
  });

  // Flip: in the graph path, take `{{run_id}}` out (the same-day rerun then shares the folder); or in run-manifest.ts resolveRunFile, return rows[0] whatever the count.
  it("two runs of one {{date}}-style graph on the same day: both outputs exist, each consumer is handed its own run's folder, and nothing else is new", async () => {
    const w = await runHomeWorld({ use: [reply({ n: 1, handoff: "h" })] });
    dispose = w.dispose;
    const before = w.find();
    const graph = reportGraph("reports/{{date}}-{{run_id}}/");
    const a = await w.start(graph, { note: "from run A" }).done;
    const b = await w.start(graph, { note: "from run B" }).done;
    expect([a.status, b.status]).toEqual(["succeeded", "succeeded"]);
    expect(a.runId).not.toBe(b.runId);
    const day = new Date().toISOString().slice(0, 10);
    const mine = (id: string) => `reports/${day}-${id}/report.md`;
    expect(readFileSync(join(w.checkout, mine(a.runId)), "utf8")).toBe(`report of ${a.runId}: from run A`);
    expect(readFileSync(join(w.checkout, mine(b.runId)), "utf8")).toBe(`report of ${b.runId}: from run B`);
    // The consumer of each run was told its own run's path and no other.
    expect(promptOf(w.spawned, 0)).toContain(mine(a.runId)); expect(promptOf(w.spawned, 0)).not.toContain(b.runId);
    expect(promptOf(w.spawned, 1)).toContain(mine(b.runId)); expect(promptOf(w.spawned, 1)).not.toContain(a.runId);
    // Nothing outside the two runs' own paths is new: the two report folders and the two run manifests. Neither run replaced the other.
    expect(w.find().filter((path) => !before.includes(path))).toEqual([
      `.agents/runs/${a.runId}/manifest.json`, `.agents/runs/${b.runId}/manifest.json`, mine(a.runId), mine(b.runId),
    ].sort());
    expect(files(renderRunManifest(w.db, b.runId)!)[0]!.replaces).toBeUndefined();
    expect(w.refused).toEqual([]);
  });

  // Flip: in run-manifest.ts recordRunFileRow, drop the `replaces` value (the replacement stops being recorded).
  it("a graph that still writes one path per day: the rerun REPLACES the file (never keeps yesterday's), and the replacement is in the manifest and the log", async () => {
    const w = await runHomeWorld({ use: [reply({ n: 1, handoff: "h" })] });
    dispose = w.dispose;
    const graph = reportGraph("reports/{{date}}/");
    const a = await w.start(graph, { note: "A" }).done;
    const b = await w.start(graph, { note: "B" }).done;
    const path = `reports/${new Date().toISOString().slice(0, 10)}/report.md`;
    expect(readFileSync(join(w.checkout, path), "utf8")).toBe(`report of ${b.runId}: B`);
    expect(files(renderRunManifest(w.db, b.runId)!)[0]!.replaces).toBe(`${a.runId}:${path}`);
    expect(files(renderRunManifest(w.db, a.runId)!)[0]!.replaces).toBeUndefined();
    expect(w.logs.some((line) => line.includes("replaced") && line.includes(path) && line.includes(a.runId))).toBe(true);
  });
});

describe("the run folder: the engine's step-input spill", () => {
  const big = Array.from({ length: 60 }, (_, at) => `Task number ${at} of the plan: a sentence long enough to push the input over the limit.`);
  const reader = chain({
    nodes: [agent("read", { produces: [{ kind: "report", version: 1 }] }), { id: "done", type: "action", action: "emit", map: { n: "read.n" } }],
    inputs: [{ name: "goal", type: "string" }, { name: "tasks", type: "array" }],
    outputs: [{ name: "n", type: "number", required: false }],
    edges: [{ from: "start", to: "read" }, { from: "read", to: "done" }],
  });

  // Flip: in workflow-executors.ts, drop the `noteRunFiles` line after the spill write.
  it("R2 spill → step: the long input stays under the PM chat's folder and the run's manifest names it, for this step, with its hash", async () => {
    const w = await runHomeWorld({ read: [reply({ n: 1, handoff: "h" })] });
    dispose = w.dispose;
    const summary = await w.start(reader, { goal: "Rate-limit the export endpoint", tasks: big }).done;
    expect(summary.status).toBe("succeeded");
    const [spill] = files(renderRunManifest(w.db, summary.runId)!).filter((row) => row.kind === "step-input");
    expect(spill).toMatchObject({ readers: ["read"], produced_by: { node: "read" } });
    const spillFolder = `.bb/chats/run-home-pm/artifacts/wf-${summary.runId.slice(0, 24)}/`;
    expect(spill!.path.startsWith(`${spillFolder}tasks.`) && spill!.path.endsWith(".json")).toBe(true);
    expect(promptOf(w.spawned, 0)).toContain(spill!.path);
    expect(JSON.parse(readFileSync(join(w.checkout, spill!.path), "utf8"))).toEqual(big);
    const read = await readRunFile(w.db, checkoutFileIo(w.ctx, { hostId: "local", path: w.checkout }), { runId: summary.runId, kind: "step-input", repoPath: spill!.path, reader: "read" });
    expect(read?.drift).toBe(false);
  });

  // Flip: in packages/workflow-engine/src/handoff.ts refPath, send an empty chat id back to `.bb/chats//…` (or in workflow-agent.ts stepPacket restore `?? "chat"`).
  it("R3 spill of a run with no PM chat: the input goes into the run's own folder, not a shared pseudo-chat folder", async () => {
    const w = await runHomeWorld({ read: [reply({ n: 1, handoff: "h" })] }, { noPm: true });
    dispose = w.dispose;
    const summary = await w.start(reader, { goal: "Rate-limit the export endpoint", tasks: big }).done;
    expect(summary.status).toBe("succeeded");
    const [spill] = files(renderRunManifest(w.db, summary.runId)!).filter((row) => row.kind === "step-input");
    expect(spill!.path.startsWith(`.agents/runs/${summary.runId}/inputs/tasks.`) && spill!.path.endsWith(".json")).toBe(true);
    expect(existsSync(join(w.checkout, ".bb/chats/chat"))).toBe(false);
    expect(JSON.parse(readFileSync(join(w.checkout, spill!.path), "utf8"))).toEqual(big);
  });
});

describe("consumes names its producer", () => {
  // Flip: in workflow-executors.ts, put the project-artifact fallback back (`|| listProjectArtifacts(db, rt.projectId, { kind: spec.kind }).length > 0`).
  it("R4 consumes without a producer in this run fails, even when the project holds an artifact of that kind from another run", async () => {
    const w = await runHomeWorld({ read: [reply({ n: 1, handoff: "h" })] });
    dispose = w.dispose;
    upsertProjectArtifact(w.db, { projectId: PROJECT, artifactId: "seo.report.old", domain: "seo", kind: "plan", relPath: ".agents/seo/old/plan.json", sha256: "a".repeat(64), summary: "another run's plan", producerWf: "other", producerRunId: "wfrun_old" });
    const wants = chain({
      nodes: [agent("read", { consumes: [{ kind: "plan", version: 1 }], produces: [{ kind: "report", version: 1 }] }), { id: "done", type: "action", action: "emit", map: { n: "read.n" } }],
      outputs: [{ name: "n", type: "number", required: false }],
      edges: [{ from: "start", to: "read" }, { from: "read", to: "done" }],
    });
    const summary = await w.start(wants).done;
    expect(summary.status).toBe("failed");
    expect(summary.error).toMatch(/consumes_missing: read needs plan\/1, which no upstream step of this run produced/);
    expect(w.spawned).toHaveLength(0);
    // Naming the source is the way: an input the caller passed in satisfies it.
    const named = chain({
      inputs: [{ name: "plan", type: "string" }],
      nodes: [agent("read", { consumes: [{ kind: "plan", version: 1, from: "$inputs", as: "plan" }], produces: [{ kind: "report", version: 1 }] }), { id: "done", type: "action", action: "emit", map: { n: "read.n" } }],
      outputs: [{ name: "n", type: "number", required: false }],
      edges: [{ from: "start", to: "read" }, { from: "read", to: "done" }],
    });
    expect((await w.start(named, { plan: "the plan" }).done).status).toBe("succeeded");
  });
});

describe("a rerun is never a silent no-op", () => {
  const retro = chain({
    inputs: [{ name: "insights", type: "array" }, { name: "goal", type: "string", required: false, default: "m" }],
    nodes: [{ id: "living", type: "action", action: "lp.retro_living", out: { updated: "int", total: "int", path: "string" } }, { id: "done", type: "action", action: "emit", map: { total: "living.total" } }],
    outputs: [{ name: "total", type: "number", required: false }],
    edges: [{ from: "start", to: "living" }, { from: "living", to: "done" }],
  });

  // Flip: in workflow-project-actions.ts lp.retro_living, write through `bb.sdk.files.write(... expectedSha256: null)` again.
  it("R5 lp.retro_living: the second milestone's insights land in the file the first one made (the create-only write did nothing)", async () => {
    const w = await runHomeWorld();
    dispose = w.dispose;
    saveProjectSetting(w.db, PROJECT, "retro.living", "on");
    const one = await w.start(retro, { insights: [{ id: "INS-00000001", title: "first lesson", lens: "process" }], goal: "milestone one" }).done;
    expect(one.status).toBe("succeeded");
    const two = await w.start(retro, { insights: [{ id: "INS-00000002", title: "second lesson", lens: "quality" }], goal: "milestone two" }).done;
    expect(two.status).toBe("succeeded");
    const text = readFileSync(join(w.checkout, ".agents/retro/LIVING.md"), "utf8");
    expect(text).toContain("INS-00000001");
    expect(text).toContain("INS-00000002");
    expect(text).toContain("(last seen milestone two)");
    expect(w.refused).toEqual([]);
  });

  const archive = chain({
    inputs: [{ name: "goal", type: "string" }],
    nodes: [{ id: "snapshot", type: "action", action: "lp.milestone_archive", name: "{{$inputs.goal}}", out: { folder: "string" } }, { id: "done", type: "action", action: "emit", map: { folder: "snapshot.folder" } }],
    outputs: [{ name: "folder", type: "string", required: false }],
    edges: [{ from: "start", to: "snapshot" }, { from: "snapshot", to: "done" }],
  });

  // Flip: in workflow-project-actions.ts lp.milestone_archive, write through `bb.sdk.files.write(... expectedSha256: null)` again.
  it("R6 lp.milestone_archive: the second archive's line is added to INDEX.md (the create-only write dropped it)", async () => {
    const w = await runHomeWorld();
    dispose = w.dispose;
    saveProjectSetting(w.db, PROJECT, "milestone.archive", "on");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(w.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(w.checkout, ".agents/planning/ROADMAP.md"), "# Roadmap\n");
    expect((await w.start(archive, { goal: "alpha" }).done).status).toBe("succeeded");
    expect((await w.start(archive, { goal: "beta" }).done).status).toBe("succeeded");
    const index = readFileSync(join(w.checkout, ".agents/planning/milestones/INDEX.md"), "utf8");
    expect(index).toMatch(/alpha/);
    expect(index).toMatch(/beta/);
    expect(w.refused).toEqual([]);
  });
});

describe("a «latest» pointer names its run", () => {
  // Flip: in sp-executors.ts sp.run_script, pass `runId: "wfrun_x"`-style wrong producer, or drop the `spDeps.noteRunFiles` line.
  it("R7 sp.run_script (latest_out) → the next graph's reader: the pointer file and the manifest name the run that wrote the current bridge, and the reader's read is recorded", async () => {
    const w = await runHomeWorld();
    dispose = w.dispose;
    const bridge = (days: number) => chain({
      nodes: [
        { id: "query_bridge", type: "action", action: "sp.run_script", skill: "mkt-yandex-direct-epk", script: "seo_ppc_bridge.py",
          args: { paid: "", organic: "", window_days: days, allow_fixture: true, latest_out: ".agents/seo/ppc-bridge-latest.json" }, out: { bridge_path: "string" } },
        { id: "done", type: "action", action: "emit", map: { bridge_path: "query_bridge.bridge_path" } },
      ],
      outputs: [{ name: "bridge_path", type: "string", required: false }],
      edges: [{ from: "start", to: "query_bridge" }, { from: "query_bridge", to: "done" }],
    });
    const first = await w.start(bridge(28)).done;
    expect(first.status).toBe("succeeded");
    const second = await w.start(bridge(14)).done;
    expect(second.status).toBe("succeeded");
    const latest = ".agents/seo/ppc-bridge-latest.json";
    const onDisk = JSON.parse(readFileSync(join(w.checkout, latest), "utf8")) as { produced_by: { run_id: string; workflow_id: string; node_id: string } };
    expect(onDisk.produced_by).toMatchObject({ run_id: second.runId, workflow_id: "run-home-chain", node_id: "query_bridge" });
    const pointer = resolveLatestPointer(w.db, PROJECT, latest)!;
    expect(pointer.runId).toBe(second.runId);
    // The first run's row stays: its manifest says what it wrote; the second says it replaced the first's.
    expect(files(renderRunManifest(w.db, first.runId)!).map((row) => row.path)).toContain(latest);
    expect(files(renderRunManifest(w.db, second.runId)!).find((row) => row.path === latest)!.replaces).toBe(`${first.runId}:${latest}`);
    const read = await readRunFile(w.db, checkoutFileIo(w.ctx, { hostId: "local", path: w.checkout }), { runId: pointer.runId, kind: "latest-pointer", repoPath: latest, reader: "sp.load_memory" });
    expect(read?.drift).toBe(false);
  });
});

describe("every graph that writes by date or slug writes a folder of its own per run", () => {
  // Flip: take `{{run_id}}` out of any path below, or add an fs.write path with `{{date}}`/`{{slug}}` and no `{{run_id}}`.
  it("R8 no fs.write path of a shipped graph is shared by two runs of the same day or the same topic", () => {
    const dir = join(__dirname, "../../workflows");
    const shared: string[] = [];
    let checked = 0;
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
      const graph = JSON.parse(readFileSync(join(dir, name), "utf8")) as { nodes?: Array<{ id: string; action?: string; path?: string }> };
      for (const node of graph.nodes ?? []) {
        if (node.action !== "fs.write" || typeof node.path !== "string") continue;
        checked += 1;
        if (/\{\{(date|slug|\$inputs\.slug)\}\}/.test(node.path) && !node.path.includes("{{run_id}}")) shared.push(`${name}:${node.id}:${node.path}`);
      }
    }
    expect(checked).toBeGreaterThan(15);
    expect(shared).toEqual([]);
  });
});

describe("deliverRunFile: a content-addressed file is written once, reused when the bytes match, never overwritten when they differ", () => {
  const file = { path: ".bb/chats/pm/artifacts/wf-run/inputs.abc12345.json", text: '{"a":1}' };
  const at = { hostId: "local", path: "/checkout" };
  const filesReturning = (answer: unknown) => ({ write: async () => answer });

  it("asks the SDK for create-only (expectedSha256: null) and treats a conflict with the same hash as already delivered", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const files = { write: async (args: Record<string, unknown>) => { seen.push(args); return { outcome: "written" }; } };
    await deliverRunFile(files as never, at, file);
    expect(seen[0]).toMatchObject({ hostId: "local", rootPath: "/checkout", path: "/checkout/.bb/chats/pm/artifacts/wf-run/inputs.abc12345.json", expectedSha256: null });
    await expect(deliverRunFile(filesReturning({ outcome: "conflict", currentSha256: sha256Hex(file.text) }) as never, at, file)).resolves.toBeUndefined();
    await expect(deliverRunFile(filesReturning({ outcome: "conflict", currentSha256: "0".repeat(64) }) as never, at, file)).rejects.toThrow("different bytes");
    // The shared create-only contract is strict: a missing or unstructured SDK answer is a failed required delivery, never an assumed write.
    await expect(deliverRunFile(filesReturning(undefined) as never, at, file)).rejects.toThrow("not applied");
    await expect(deliverRunFile(filesReturning({}) as never, at, file)).rejects.toThrow("not applied");
    await expect(deliverRunFile(filesReturning({ outcome: "maybe" }) as never, at, file)).rejects.toThrow("not applied");
  });
});
