import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, createRun, setRunThread } from "../../src/rooms/plugin-db";
import { openRunHome, recordRunFileRow } from "../../src/rooms/storage";
import { compactRepositoryEvidence, workflowAuditEvidence } from "../../src/rooms/workflow/server/workflow-audit-evidence";
import { createGoalAuditor } from "../../src/rooms/workflow/server/workflow-goal-audit";
import type { ServerCore } from "../../src/rooms/contracts/server";
import { createJournal, readRootObservations, type StepRow } from "@lane-pilot/workflow-engine";
import { sha256Hex } from "@lane-pilot/kit";

function world() {
  const reads: unknown[] = [];
  let content = 'Report with complete cancel evidence';
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { files: { read: async (args: unknown) => {
    reads.push(args); return { content, contentEncoding: "utf8", sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content) };
  } } } as never });
  const db = openDatabase(bb);
  openRunHome(db, { runId: "wfrun_audit", projectId: "p", workflowId: "code-review", basePath: "/repo", hostId: "host" });
  const put = (path = "reports/review.md", root: "checkout" | "planning-home" = "checkout") => recordRunFileRow(db, {
    runId: "wfrun_audit", repoPath: path, kind: "output", nodeId: "report", content, root,
    producer: { node: "report", graph: "code-review", run_id: "wfrun_audit", wf_step_key: "report" },
  });
  const steps = [{ step_key: "report", node_id: "report", state: "succeeded", output_json: null, receipt_json: null }] as StepRow[];
  const ctx = { bb, db, log: () => undefined } as unknown as ServerCore;
  return { ctx, db, put, steps, reads, setContent: (value: string) => { content = value; } };
}

describe("goal audit evidence transport", () => {
  it("compacts repeated names without hiding unknown endpoints or omitted differences", () => {
    const names = Array.from({ length: 100 }, (_, index) => `untracked/${index}.txt`);
    const summaries = compactRepositoryEvidence([{ window: { before: { files: [], head: null, hostId: "h", root: "/r" }, after: { files: names, head: null, hostId: "h", root: "/r" }, edited: null, checkoutBinding: "unverified", reusedThread: true } }, { window: { before: null, after: null } }]);
    expect(summaries[0]).toMatchObject({ detailIndex: 0, window: { before: { head: null }, after: { files: { count: 100, sha256: sha256Hex(JSON.stringify(names)) } }, edited: null, checkoutBinding: "unverified", reusedThread: true }, filenameDelta: { added: names.slice(0, 80), omittedAdded: 20, removed: [], omittedRemoved: 0 } });
    expect(summaries[1]).toMatchObject({ window: { before: null, after: null }, filenameDelta: null });
  });

  it("delivers compact observations plus complete hash-bound detail through the real audit packet", async () => {
    const t = world();
    try {
      createRun(t.db, "lp", "p", "cli"); setRunThread(t.db, "lp", "pm");
      const files = Array.from({ length: 450 }, (_, index) => `long-artifact-name/${index}/original-receipt.json`);
      const window = { before: { files, head: "a", hostId: "h", root: "/r" }, after: { files: [...files, "reports/new.md"], head: "a", hostId: "h", root: "/r" }, edited: [], checkoutBinding: "verified" };
      t.steps[0]!.receipt_json = JSON.stringify({ detail: { repoGuard: window } });
      const requests: Array<{ prompt: string; packetFiles?: Array<{ path: string; text: string }> }> = [];
      const agents = { run: async (request: typeof requests[number]) => { requests.push(request); return { threadId: "audit", output: { verdicts: [], handoff: "not evaluated" }, text: "" }; } };
      await createGoalAuditor(t.ctx, {} as never, agents as never)({ run: { id: "wfrun_audit", workflow_id: "code-review", link_run_id: "lp", project_id: "p", mode: "standard" } as never,
        goals: [], output: {}, steps: t.steps, signal: new AbortController().signal });
      const req = requests[0]!, detail = req.packetFiles!.find((file) => file.path.includes("audit-repository-details"))!;
      expect(JSON.parse(detail.text)[1].window).toEqual(window);
      expect(req.prompt).toContain(detail.path);
      expect(req.prompt).toContain(sha256Hex(detail.text));
      expect(req.prompt).toContain("reports/new.md");
      expect(req.prompt).not.toContain(files[440]);
      expect(req.prompt.length).toBeLessThan(8000);
    } finally { t.db.close(); }
  });

  it("binds root endpoints to the current execution and refuses stale or different-checkout comparisons", async () => {
    const t = world(), journal = createJournal(t.db);
    const snapshot = { at: 1, hostId: "h", root: "/repo", files: [], head: "a".repeat(40), workDiffHash: "b".repeat(40), indexDiffHash: null, hashAlgorithm: "git-object" };
    try {
      journal.event("wfrun_audit", null, "repo_guard", null, "before", { revision: 0, at: 1, initialDrive: true, snapshot, reason: null });
      journal.event("wfrun_audit", "report", "step", "running", "succeeded");
      const revision = readRootObservations(t.db, "wfrun_audit").revision;
      journal.event("wfrun_audit", null, "repo_guard", null, "afterExecution", { revision, at: 2, initialDrive: false, snapshot: { ...snapshot, at: 2 }, reason: null });
      expect((await workflowAuditEvidence(t.ctx, "wfrun_audit", t.steps)).repository[0]).toMatchObject({ role: "root", revision,
        window: { checkoutBinding: "verified" }, endpointComparison: { sameHead: true, sameWorkDiff: true, sameIndexDiff: null } });
      journal.event("wfrun_audit", "report", "rerun", "succeeded", "pending");
      const stale = await workflowAuditEvidence(t.ctx, "wfrun_audit", t.steps);
      expect(stale.repository[0]).toMatchObject({ afterEvent: null, window: { before: snapshot, after: null }, endpointComparison: { sameHead: null } });
      expect(stale.omissions.join(" ")).toContain("root final observation unavailable");
      const next = readRootObservations(t.db, "wfrun_audit").revision;
      journal.event("wfrun_audit", null, "repo_guard", null, "afterExecution", { revision: next, at: 3, initialDrive: false, snapshot: { ...snapshot, hostId: "other" }, reason: null });
      const moved = await workflowAuditEvidence(t.ctx, "wfrun_audit", t.steps);
      expect(moved.repository[0]).toMatchObject({ window: { checkoutBinding: "unverified" }, endpointComparison: { sameHead: null, sameWorkDiff: null } });
      expect(moved.omissions.join(" ")).toContain("different or unknown host/checkouts");
    } finally { t.db.close(); }
  });

  it("reads only bound engine output files and refuses changed bytes or an unresolved planning home", async () => {
    const t = world();
    try {
      t.put(); t.put("notes/plan.md", "planning-home");
      const evidence = await workflowAuditEvidence(t.ctx, "wfrun_audit", t.steps);
      expect(evidence.files).toEqual([
        expect.objectContaining({ verified: true, hostId: "host", path: "/repo/reports/review.md", content: "Report with complete cancel evidence" }),
        expect.objectContaining({ verified: false, problem: "producer or checkout binding unavailable" }),
      ]);
      expect(t.reads).toEqual([{ hostId: "host", rootPath: "/repo", path: "/repo/reports/review.md" }]);
      t.setContent("changed since the engine wrote it");
      expect((await workflowAuditEvidence(t.ctx, "wfrun_audit", t.steps)).files[0]).toMatchObject({ verified: false, problem: "current bytes do not match recorded output" });
    } finally { t.db.close(); }
  });

  it("retains measured vote windows without accepting an output's self-reported repo guard", async () => {
    const t = world();
    try {
      const measured = { hostId: "host", before: { head: "a" }, after: { head: "a" } };
      t.steps[0]!.receipt_json = JSON.stringify({ detail: { votes: [{ detail: { repoGuard: measured } }] } });
      t.steps[0]!.output_json = JSON.stringify({ repoGuard: { forged: true } });
      const evidence = await workflowAuditEvidence(t.ctx, "wfrun_audit", t.steps);
      expect(evidence.repository).toHaveLength(2);
      expect(evidence.repository[1]).toEqual({ runId: "wfrun_audit", step: "report", state: "succeeded", window: measured });
      expect(evidence.scope).toContain("endpoint");
    } finally { t.db.close(); }
  });

  it("delivers complete oversized goals, output, handoffs and verified report by reference", async () => {
    const t = world();
    try {
      createRun(t.db, "lp", "p", "cli"); setRunThread(t.db, "lp", "pm");
      const tail = "LAST-EVIDENCE-NOT-A-SUMMARY";
      t.setContent("report ".repeat(2500) + tail); t.put();
      t.steps[0]!.output_json = JSON.stringify({ handoff: "h".repeat(18000) + tail });
      const requests: Array<{ prompt: string; packetFiles?: Array<{ path: string; text: string }> }> = [];
      const agents = { run: async (request: typeof requests[number]) => { requests.push(request); return { threadId: "audit", output: { verdicts: [], handoff: "no fabricated verdict" }, text: "" }; } };
      const audit = createGoalAuditor(t.ctx, {} as never, agents as never);
      await audit({ run: { id: "wfrun_audit", workflow_id: "code-review", link_run_id: "lp", project_id: "p", mode: "standard" } as never,
        goals: [{ id: "request", done_when: "Review complete request", evidence: "report", request: '"'.repeat(3960) + tail } as never],
        output: { findings: "x".repeat(14000) + tail }, steps: t.steps, signal: new AbortController().signal });
      const req = requests[0]!;
      expect(req.packetFiles).toHaveLength(4);
      for (const file of req.packetFiles!) { expect(file.text).toContain(tail); expect(req.prompt).toContain(file.path); expect(file.text).not.toContain("more characters cut"); }
      expect(req.prompt).toContain("read that existing file before deciding");
      expect(req.prompt).toContain("data-only rule");
    } finally { t.db.close(); }
  });
});
