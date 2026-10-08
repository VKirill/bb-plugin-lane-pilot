import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { definitionSha256, type StoredWorkflow } from "../../src/workflow/store";
import { createStatusResolver } from "../../src/workflow/ops-store";
import { parseWorkflowObject } from "../../src/workflow/schema";
import { journalDb } from "./engine-helpers";

// Audit 2026-10-08 round 4, item 15: a run ends `succeeded` also on the branches that did not do the job (the owner said abort,
// Elba showed a login wall), so «a live run succeeded» made invoice-send `published` after a run that sent nothing.
const WORKFLOWS = join(__dirname, "..", "..", "workflows");
const load = (id: string) => {
  const parsed = parseWorkflowObject(JSON.parse(readFileSync(join(WORKFLOWS, `${id}.json`), "utf8")));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
};
const stored = (workflow: ReturnType<typeof load>): StoredWorkflow => ({ workflow, origin: "builtin", source: workflow.id, sha256: definitionSha256(workflow), warnings: [] });

function run(db: ReturnType<typeof journalDb>, workflow: ReturnType<typeof load>, id: string, output: unknown, extra: { status?: string; parent?: string | null } = {}) {
  db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,status,output_json,parent_run_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, workflow.id, workflow.version, "x", "{}", extra.status ?? "succeeded", output === null ? null : JSON.stringify(output), extra.parent ?? null, 1, 1);
}

describe("a tested chain becomes published only after a live run that did the job", () => {
  it("invoice-send stays tested after aborted, blocked, send_failed and send_unconfirmed runs, and is published after a sent one", () => {
    const db = journalDb();
    const resolver = createStatusResolver(db);
    const invoice = load("invoice-send");
    for (const status of ["aborted", "blocked", "send_failed", "send_unconfirmed"]) run(db, invoice, `r-${status}`, { status });
    expect(resolver.resolve(stored(invoice)).status).toBe("tested");
    expect(resolver.liveSuccess(invoice.id, invoice.version, invoice.live_success)).toBeUndefined();
    run(db, invoice, "r-failed-sent", { status: "sent" }, { status: "failed" });
    expect(resolver.resolve(stored(invoice)).status).toBe("tested");
    run(db, invoice, "r-sent", { status: "sent", message_id: "m1" });
    expect(resolver.resolve(stored(invoice)).status).toBe("published");
    expect(resolver.liveSuccess(invoice.id, invoice.version, invoice.live_success)?.id).toBe("r-sent");
  });

  it("every built-in tested chain with a status output says which statuses prove it", () => {
    for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".json"))) {
      const workflow = load(file.replace(/\.json$/, ""));
      if (workflow.status !== "tested") continue;
      expect(workflow.live_success, workflow.id).toBeTruthy();
      expect(workflow.live_success!.in.length, workflow.id).toBeGreaterThan(0);
    }
  });

  it("a chain without a rule keeps the old meaning: any succeeded run proves it", () => {
    const db = journalDb();
    const resolver = createStatusResolver(db);
    const plain = { ...load("invoice-send"), id: "plain", live_success: undefined };
    run(db, plain, "r1", { status: "aborted" });
    expect(resolver.resolve(stored(plain)).status).toBe("published");
  });
});
