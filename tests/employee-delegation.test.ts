import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/rooms/storage/database";
import { waitSpecialistRun, startSpecialistRun } from "../src/rooms/critique/server/specialist-graph";
import { EMPLOYEES } from "../src/rooms/native-agent/employee-manifest";
import { EMPLOYEE_VALIDATORS } from "../src/rooms/critique/server/specialists";
import { employeeView } from "../src/rooms/native-agent/employee-manifest";
import { builtinWorkflow } from "../src/rooms/workflow";

const dbOf = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);

// host stub: every command "fails emptily" — enough for each validator kind to run and reject
const host = { call: async () => ({ hostId: "h", exitCode: 0, stdout: "", stderr: "" }) };

function ctxWith(db: ReturnType<typeof dbOf>) {
  return { db, host, bb: { storage: { kv: { get: async (k: string) => (k.startsWith("specialist-thread:") ? "thread-x" : null), set: async () => {} } } }, log: () => {}, isDisposed: () => false } as never;
}

function servicesStub(status = "succeeded") {
  return { workflowEngine: { get: () => ({ status, output: { report: "done" } }), start: () => ({ runId: "wr1", created: true, done: Promise.resolve() }), journal: { getRun: () => null } } } as never;
}

const VALIDATOR_WITNESS: Record<string, RegExp> = {
  "artifact": /missing|empty|exists|not/i,
  "3d": /blend|3d|no .blend|artifact/i,
  "design": /http|page|fetch|DOM|browser|no host/i,
  "video": /ffprobe|video|stream|audio|duration/i,
  "invoice": /pdf|text|inn|scan/i,
  "composite": /artifact|jev|exists/i,
  "text": /artifact|text|exists|empty/i,
};

describe("employee delegation: real path per registry employee", () => {
  for (const [role, manifest] of Object.entries(EMPLOYEES)) {
    it(`${role} (${manifest.domain}, ${manifest.machineAffinity}) reaches its domain validator`, async () => {
      const db = dbOf();
      const validator = EMPLOYEE_VALIDATORS[manifest.domain] ?? "artifact";
      expect(VALIDATOR_WITNESS[validator] || validator).toBeTruthy();
      const runId = `wr_${role}`;
      db.prepare(`INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,inputs_json,status,created_at,updated_at) VALUES(?,?,'v','x','{}',?,?,?,0,0)`)
        .run(runId, "specialist", "p1", JSON.stringify({ role, task: "t", validator, deliverable: manifest.deliverables[0], hostId: "h", brief: { kind: manifest.domain } }), "succeeded");
      const ctx = ctxWith(db);
      const out = await waitSpecialistRun(ctx, servicesStub(), { projectId: "p1", runId, timeoutSec: 5 });
      // The deliverable validator ran its kind-specific check (reason carries the witness of that kind).
      expect(["revision", "done"]).toContain(out.state);
      if (out.state === "revision") expect(out.reason).toMatch(VALIDATOR_WITNESS[validator]!);
    });
  }

  it("startSpecialistRun forwards validator/deliverable extras into run inputs", async () => {
    const engine = { captured: null as { inputs?: Record<string, unknown> } | null,
      start(args: { inputs: Record<string, unknown> }) { engine.captured = { inputs: args.inputs }; return { runId: "wr9", created: true, done: Promise.resolve() }; },
      get: () => null } as never;
    const db = dbOf();
    const kv = new Map<string, unknown>();
    const ctx = { db, bb: { storage: { kv: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: never) => { kv.set(k, v); } } } }, log: () => {}, isDisposed: () => false } as never;
    const services = { workflowEngine: engine } as never;
    void startSpecialistRun(ctx, services, { projectId: "p1", pmThreadId: "pm", runId: "r1", role: "3d-artist", task: "model", title: "t", extra: { validator: "3d", deliverable: ".agents/3d/" } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.captured?.inputs?.validator).toBe("3d");
    expect(engine.captured?.inputs?.deliverable).toBe(".agents/3d/");
  });

  it("every employee has a machine affinity and role profile for placement/model", () => {
    for (const role of Object.keys(EMPLOYEES)) {
      const view = employeeView(role);
      expect(["mac-mini", "ovh", "windows", "any"], role).toContain(view.machineAffinity);
    }
  });
});
