import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/rooms/storage/database";
import { recordEmployeeLesson, specialistMemorySlice, roleLinesKey, judgeEmployeeRemark } from "../src/rooms/critique/server/employee-lessons";
import { EMPLOYEES } from "../src/rooms/native-agent/employee-manifest";
import { EMPLOYEE_VALIDATORS, SPECIALIST_ROLES, specialistPrompt, registerSpecialistActions } from "../src/rooms/critique/server/specialists";
import { employeeRemarkJudgment } from "@lane-pilot/jev/judgments/employee-remark";
import { createJev, setJevForTests, type JevClient } from "@lane-pilot/jev";

const db = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const kv = () => { const m = new Map<string, unknown>(); return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: never) => { m.set(k, v); } }; };

describe("employee lessons", () => {
  it("recordEmployeeLesson writes a dated role line and a specialist:<role> proposal", async () => {
    const d = db(), k = kv();
    const out = await recordEmployeeLesson(k as never, d, { projectId: "p1", role: "3d-artist", line: "always triangulate on export" });
    expect(out.line).toMatch(/^\d{4}-\d{2}-\d{2}: always triangulate/);
    expect(await k.get(roleLinesKey("p1", "3d-artist"))).toEqual([out.line]);
    expect(specialistMemorySlice(d, "p1", "3d-artist")).toEqual(["always triangulate on export"]);
    expect(specialistMemorySlice(d, "p1", "video-lead")).toEqual([]);
  });

  it("the lesson reaches the next specialist brief (real lp.specialist_brief path)", async () => {
    const k = kv();
    const lines: string[] = [];
    const engine = { register: (_name: string, ex: { run: (c: never) => Promise<{ output: { text: string } }> }) => lines.push("ok") && Object.assign(engine, { ex }) } as never;
    const ctx = { bb: { storage: { kv: k } } } as never;
    await recordEmployeeLesson(k as never, db(), { projectId: "p1", role: "3d-artist", line: "always triangulate on export" });
    registerSpecialistActions(engine as never, ctx as never);
    const out = await (engine as { ex: { run(c: unknown): Promise<{ output: { text: string } }> } }).ex.run({
      resolve: (k: string) => ({ "$inputs.role": "3d-artist", "$inputs.task": "model a chest" })[k] ?? "",
      runtime: { projectId: "p1" },
    });
    expect(out.output.text).toContain("Lines added to your role in this project");
    expect(out.output.text).toContain("triangulate on export");
  });

  it("employee.remark judgment and judgeEmployeeRemark honour jev.modes", async () => {
    const d = employeeRemarkJudgment.decide({ remark: { type: "noul", noul: 0.9 } }, { remark_p: 0.6 });
    expect(d.decision?.remark).toBe(true);
    const client = {
      breaker: () => ({ open: false, failures: 0 }),
      async call(request: { questions: Record<string, unknown> }) {
        const answers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul: 0.95 }]));
        return { ok: true as const, answers, model: "t", usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, attempts: 1 };
      },
    } as unknown as JevClient;
    setJevForTests(createJev({ client, db: null }));
    const got = await judgeEmployeeRemark({ settings: { "jev.modes": "employee.remark=active" } }, { projectId: "p1", role: "3d-artist", text: "always triangulate" });
    setJevForTests(null);
    expect(got).toEqual({ remark: true, by: "jev" });
  });

  it("every registry employee has a validator kind and deliverables for deliverable.validate", () => {
    for (const [role, m] of Object.entries(EMPLOYEES)) {
      expect(EMPLOYEE_VALIDATORS[m.domain] ?? "artifact", `${role} domain ${m.domain}`).toBeTruthy();
      expect(m.deliverables.length, role).toBeGreaterThan(0);
    }
    expect(Object.keys(EMPLOYEES)).toEqual(expect.arrayContaining(["3d-artist", "game-dev", "video-lead", "seo-specialist", "copy-lead", "design-lead", "social-manager", "billing-assistant", "macos-operator", "visual-artist"]));
  });
});
