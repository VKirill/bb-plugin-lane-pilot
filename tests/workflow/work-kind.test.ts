import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORK_KINDS, workKindOf } from "@lane-pilot/contracts";
import { loadWorkflow, parseWorkflow, parseWorkflowObject } from "@lane-pilot/workflow-engine";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { buildPmCatalog } from "../../src/rooms/workflow/models/pm-catalog";
import { createWorkflowLibrary } from "../../src/rooms/workflow/server/services/workflow-library";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../src/rooms/services";
import { engineOn, journalDb } from "./engine-helpers";
import { workflow } from "./fixtures";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("work kinds", () => {
  it("parses valid work kinds, treats absent as routine, and refuses unknown values", () => {
    expect(WORK_KINDS).toEqual(["routine", "employee", "project"]);
    for (const kind of WORK_KINDS) {
      const parsed = parseWorkflow(workflow({ id: `wf-${kind}`, kind }));
      expect(parsed.kind).toBe(kind);
      expect(workKindOf(parsed.kind)).toBe(kind);
    }

    const absent = parseWorkflow(workflow({ id: "wf-absent" }));
    expect(absent.kind).toBeUndefined();
    expect(workKindOf(absent.kind)).toBe("routine");

    const invalidObj = parseWorkflowObject(workflow({ id: "wf-bad", kind: "program" }));
    expect(invalidObj.success).toBe(false);
    const invalidLoad = loadWorkflow(workflow({ id: "wf-bad", kind: "program" }));
    expect(invalidLoad.ok).toBe(false);
  });

  it("annotates shipped project and employee graphs", () => {
    expect(builtinWorkflow("full-lifecycle")?.kind).toBe("project");
    expect(builtinWorkflow("roadmap-driven")?.kind).toBe("project");
    expect(builtinWorkflow("project-start")?.kind).toBe("project");
    expect(builtinWorkflow("sp-specialist-tick")?.kind).toBe("employee");
    expect(workKindOf(builtinWorkflow("analyze-plan-execute")?.kind)).toBe("routine");
  });

  it("exposes work kind in workflow library rows and the PM catalog", async () => {
    const wfRoutine = parseWorkflow(workflow({ id: "wf-routine-cat", status: "published" }));
    const wfEmployee = parseWorkflow(workflow({ id: "wf-employee-cat", status: "published", kind: "employee" }));
    const wfProject = parseWorkflow(workflow({ id: "wf-project-cat", status: "published", kind: "project" }));

    const catalog = buildPmCatalog([wfRoutine, wfEmployee, wfProject]);
    const graphs = catalog.flatMap((cat) => cat.graphs);
    expect(graphs.find((g) => g.id === "wf-routine-cat")?.kind).toBe("routine");
    expect(graphs.find((g) => g.id === "wf-employee-cat")?.kind).toBe("employee");
    expect(graphs.find((g) => g.id === "wf-project-cat")?.kind).toBe("project");

    const db = journalDb();
    const globalDir = await mkdtemp(join(tmpdir(), "lp-work-kind-"));
    dirs.push(globalDir);
    try {
      const ctx = { db, log: () => undefined, host: { call: async () => ({ hostId: "h", files: [] }) } } as unknown as ServerCore;
      const engine = engineOn(db, {}, { resolveWorkflow: () => null });
      const services = { workflowEngine: engine, docsPlaces: async () => [] } as unknown as Services;
      const lib = createWorkflowLibrary(ctx, services, { globalDir });
      const listed = await lib.list({});
      const byId = Object.fromEntries(listed.workflows.map((row) => [row.id, row]));
      expect(byId["full-lifecycle"]?.kind).toBe("project");
      expect(byId["sp-specialist-tick"]?.kind).toBe("employee");
      expect(byId["analyze-plan-execute"]?.kind).toBe("routine");
    } finally {
      db.close();
    }
  });
});
