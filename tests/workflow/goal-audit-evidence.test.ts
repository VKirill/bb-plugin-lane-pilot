import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, createRun, setRunThread } from "../../src/rooms/plugin-db";
import { openRunHome, recordRunFileRow } from "../../src/rooms/storage";
import { workflowAuditEvidence } from "../../src/rooms/workflow/server/workflow-audit-evidence";
import { createGoalAuditor } from "../../src/rooms/workflow/server/workflow-goal-audit";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { StepRow } from "@lane-pilot/workflow-engine";
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
      expect(evidence.repository).toEqual([{ runId: "wfrun_audit", step: "report", state: "succeeded", window: measured }]);
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
