import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dueProbes, type CapabilityReceipt } from "../../src/rooms/capability/logic";
import { creatorBrief, lintDraft } from "../../src/rooms/forge/logic";
import { CORE_PROVIDER_GROUPS, ROLE_PROFILES } from "../../src/rooms/native-agent/helper-context";
import { buildBubblewrapArgs } from "../../src/rooms/verification/sandbox";

const skill = (name: string, extra = "") => `---
name: ${name}
description: Use when the owner asks for a forged draft of this one skill and nothing else.
---
Steps: write the file. Never read a secret.
${extra}`;

describe("worker roles that live in Lane Pilot", () => {
  it("[sma:wr_forge] the creator is told to write one draft, and a forbidden grant is refused", () => {
    const brief = creatorBrief("skill", "cell-sum", "skip empty cells");
    expect(brief).toContain("exactly one skill draft");
    expect(brief).toContain(".agents/forge/skills/cell-sum/SKILL.md");
    expect(brief).toContain("skip empty cells");
    expect(lintDraft("skill", "cell-sum", skill("cell-sum"))).toEqual([]);
    const dirty = lintDraft("skill", "cell-sum", skill("cell-sum", "tools: *\n"));
    expect(dirty.map((row) => row.code)).toContain("forbidden_grant");
    expect(lintDraft("skill", "cell-sum", skill("other"))).toEqual(expect.arrayContaining([expect.objectContaining({ code: "name" })]));
  });

  it("[sma:wr_planner] the plan pipeline runs a planner and then a separate plan critic, neither of them the writer", () => {
    const nodes = (JSON.parse(readFileSync("workflows/lp.plan.json", "utf8")) as { nodes: Array<{ id: string; role?: string }> }).nodes;
    const roles = nodes.map((node) => node.role).filter((role): role is string => !!role);
    expect(roles).toEqual(["planner", "plan-critic"]);
    expect(roles).not.toContain("writer");
    expect(ROLE_PROFILES.planner).not.toEqual(ROLE_PROFILES.writer);
    expect(ROLE_PROFILES["plan-critic"].mcpServers).toEqual([]);
  });

  it("[sma:wr_designer] the design-lead role is a specialist profile, not the writer", () => {
    const designer = ROLE_PROFILES["specialist:design-lead"];
    expect(designer.skills).toContain("project-design");
    expect(designer).not.toEqual(ROLE_PROFILES.writer);
    expect(designer.bbPlugins).not.toContain("writer");
  });

  it("[sma:wr_vendors] claude and codex are vendor groups, and claude is one of the cores", () => {
    expect(Object.keys(CORE_PROVIDER_GROUPS)).toEqual(expect.arrayContaining(["claude-code", "codex"]));
    expect(CORE_PROVIDER_GROUPS["claude-code"]).toEqual(expect.arrayContaining(["skills", "mcpServers"]));
    expect(CORE_PROVIDER_GROUPS.codex).toEqual(expect.arrayContaining(["skills", "mcpServers"]));
  });

  it("[sma:wc_applicable] a receipt for the previous adapter version does not apply to the version installed now", () => {
    const old: CapabilityReceipt = { providerId: "claude", version: "1.0.0", capability: "pause", state: "supported", model: "opus", detail: null, at: 1 };
    const inUse = new Map([["claude", "opus"]]);
    expect(dueProbes(inUse, new Map([["claude", "2.0.0"]]), [old])).toEqual([{ providerId: "claude", model: "opus", version: "2.0.0" }]);
    expect(dueProbes(inUse, new Map([["claude", "1.0.0"]]), [old, { ...old, capability: "answers" }, { ...old, capability: "documentary" }])).toEqual([]);
  });

  it("[sma:wi_spool] [sma:wi_check] the sandbox runs one command, and its home and temp are the job folder", () => {
    const args = buildBubblewrapArgs({ workspacePath: "/work", cwd: "/work", tempPath: "/tmp/job-1", guardPaths: ["/work/.git"] });
    expect(args.slice(-4)).toEqual(["/bin/bash", "--noprofile", "--norc", "-c"]);
    expect(args).toEqual(expect.arrayContaining(["--bind", "/tmp/job-1", "/tmp/job-1", "--setenv", "HOME", "/tmp/job-1", "--setenv", "TMPDIR", "/tmp/job-1"]));
    const git = args.indexOf("/work/.git");
    expect(args[git - 1]).toBe("--ro-bind");
    const home = args.indexOf("HOME");
    const tmp = args.indexOf("TMPDIR");
    expect(args[home - 1]).toBe("--setenv");
    expect(args[home + 1]).toBe("/tmp/job-1");
    expect(args[tmp + 1]).toBe("/tmp/job-1");
  });

  it.todo("[sma:wb_human_only] push, merge, tag and release are denied on the writer's launch arguments"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:wb_danger] a worker has its own danger threshold, separate from the founder's, and it only names"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:wc_documentary] a documentary cell checks a nested call, a role definition, checker hooks and checker session end"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:wc_drill] the pause cell stays unverified until a stand drill proves it"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:wi_clone] the worker gets a standalone clone in its own root, not a linked worktree"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:wi_receipts] pipeline receipts from the clone are carried into the project journal"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:wr_models] each Claude role defaults to the top model and the highest effort"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:wr_orchestrator] the conversation orchestrator runs the conversation and takes no queue task"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:wr_vendors] an api vendor exists and claude is the default"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:wc_applicable] a change of model, config or hooks voids the receipt"); // deferral:dfr_seed_skip_sma_gaps
});
