import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planningHomeOf, planningRoot } from "../../src/rooms/contracts";
import { switchValue } from "../../src/rooms/settings/switches";
import { docsCompletenessGaps } from "../../src/rooms/docs/docs-lint";
import { roadmapNumberingGaps } from "../../src/rooms/phase/stages";
import { plansHealth, plansFix } from "../../src/rooms/project-life/plans-health";
import { writePhaseBook } from "../../src/rooms/host-worker/handlers/writes";

describe("the planning home: two addresses, writes confined to .agents under the home root", () => {
  it("[sma:m_pj_register] project.planning_home reads as an absolute path only; unset and invalid values leave the checkout as the root", () => {
    expect(planningHomeOf({})).toBeNull();
    expect(planningHomeOf({ "project.planning_home": "relative/dir" })).toBeNull();
    expect(planningHomeOf({ "project.planning_home": "/etc/../x" })).toBeNull();
    expect(planningHomeOf({ "project.planning_home": "C:\\plan" })).toBeNull();
    expect(planningHomeOf({ "project.planning_home": "/home/o/plan/" })).toBe("/home/o/plan");
    expect(planningRoot({ writer_workspace_path: "/w/checkout" }, {})).toBe("/w/checkout");
    expect(planningRoot({ writer_workspace_path: "/w/checkout" }, { "project.planning_home": "/home/o/plan" })).toBe("/home/o/plan");
    expect(planningRoot(null, {})).toBeNull();
    // The switch the owner sets it with rejects everything but an absolute path without "..".
    expect("problem" in switchValue("project.planning_home", "docs/plan")).toBe(true);
    expect("problem" in switchValue("project.planning_home", "/x/../y")).toBe(true);
    expect(switchValue("project.planning_home", "/home/o/plan")).toEqual({ value: "/home/o/plan" });
  });

  it("[sma:m_pj_planning] writePhaseBook still refuses a write outside .agents — under any root the code tree is untouched", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "plan-home-"));
    mkdirSync(join(cwd, ".agents/planning"), { recursive: true });
    const edits = [
      { path: ".agents/planning/STATE.md", expectedSha256: null, content: "# state\n" },
      { path: "src/x.ts", expectedSha256: null, content: "x" },
    ];
    const previewSha256 = await import("@lane-pilot/kit").then((kit) => kit.sha256Hex(JSON.stringify(edits)));
    await expect(writePhaseBook({ requestedHostId: "h", projectCwd: cwd, previewSha256, edits })).rejects.toThrow(/scope/);
    // …and the same call confined to the planning marks writes there only.
    const marks = [{ path: ".agents/planning/STATE.md", expectedSha256: null, content: "# state\n" }];
    const preview = await import("@lane-pilot/kit").then((kit) => kit.sha256Hex(JSON.stringify(marks)));
    const result = await writePhaseBook({ requestedHostId: "h", projectCwd: cwd, previewSha256: preview, edits: marks });
    expect(result.status).toBe("applied");
    expect(readFileSync(join(cwd, ".agents/planning/STATE.md"), "utf8")).toBe("# state\n");
  });
});

describe("the codebase map and the planning files' checks", () => {
  it("[sma:k_pl_codebase] a project root owes docs/conventions.md and docs/testing.md; a workspace does not", () => {
    const page = (type: string) => ({ path: `docs/${type}.md`, sha256: "a".repeat(64), modifiedAt: 0, content: `---\ntitle: t\ntype: ${type}\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: active\nconfidence: high\ntags: []\nsources: []\n---\n` });
    const gaps = docsCompletenessGaps([page("overview"), page("architecture"), page("gotchas")], { tables: [], core: [] });
    expect(gaps.missingPages).toEqual(expect.arrayContaining(["docs/conventions.md", "docs/testing.md"]));
    const ws = docsCompletenessGaps([page("overview")], { tables: [], core: [], workspace: true });
    expect(ws.missingPages).toEqual([]);
    const full = docsCompletenessGaps([page("overview"), page("architecture"), page("gotchas"), page("conventions"), page("testing")], { tables: [], core: [] });
    expect(full.missingPages).toEqual([]);
  });

  it("[sma:k_t_validate] a roadmap with rows 1, 2, 2, 4 reports the duplicate 2 and the skipped 3; a consistent roadmap reports nothing", () => {
    const bad = ["- [ ] 1 first", "- [ ] 2 second", "- [x] 2 second done", "- [ ] 4 fourth"].join("\n");
    expect(roadmapNumberingGaps(bad)).toEqual(expect.arrayContaining([expect.stringContaining("duplicate roadmap row 2"), expect.stringContaining("skipped roadmap row(s) between 2 and 4")]));
    expect(roadmapNumberingGaps(bad)).toHaveLength(2);
    expect(roadmapNumberingGaps(["- [ ] 1 first", "- [ ] 2 second", "- [ ] 3.1 sub"].join("\n"))).toEqual([]);
  });

  it("[sma:k_c_health] a todo folder missing from INDEX.md and an INDEX line with no folder are both reported; --fix leaves an INDEX equal to the folders", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-"));
    mkdirSync(join(root, "todos/items/real-one"), { recursive: true });
    writeFileSync(join(root, "todos/items/real-one/meta.yaml"), "status: open\n");
    writeFileSync(join(root, "todos/INDEX.md"), "# Todos\n- ghost-item\n");
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans/INDEX.md"), "# Plans\n");
    const report = plansHealth(root);
    expect(report.find((area) => area.area === "todos")!.missingInIndex).toEqual(["real-one"]);
    expect(report.find((area) => area.area === "todos")!.deadIndexLines).toEqual(["- ghost-item"]);
    const fixed = plansFix(root);
    expect(fixed).toHaveLength(1);
    const index = readFileSync(join(root, "todos/INDEX.md"), "utf8");
    expect(index).toContain("real-one");
    expect(index).not.toContain("ghost-item");
    expect(plansHealth(root)).toEqual([]);
  });
});

describe("the infra profile and the batch decision", () => {
  it("[sma:k_pl_infra] profile.* is eight free-text project switches; a value over 1000 characters is refused", () => {
    for (const key of ["stack", "test_command", "release", "hosts", "start", "deploy", "logs", "style"]) {
      expect(switchValue(`profile.${key}`, "npm test")).toEqual({ value: "npm test" });
    }
    expect("problem" in switchValue("profile.stack", "x".repeat(1001))).toBe(true);
  });

  it("[sma:d_batch_decide] phase_control takes withdraw for a piece, with the owner's note", async () => {
    const { rpcContract } = await import("../../src/rooms/contracts");
    const parsed = rpcContract.phase_control.input.safeParse({ phaseId: "ph_abcdef12", action: "withdraw", piece: "p3", note: "out of scope" });
    expect(parsed.success).toBe(true);
    expect(rpcContract.phase_control.input.safeParse({ phaseId: "ph_abcdef12", action: "withdraw", piece: "p3" }).success).toBe(true); // the note is required by the handler, the shape admits the call
    expect(rpcContract.phase_control.input.safeParse({ phaseId: "ph_abcdef12", action: "teleport" }).success).toBe(false);
  });
});
