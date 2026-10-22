import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { getRuleProposal, listRuleEvents } from "@lane-pilot/run-insights";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/storage/database";

const projectId = "rules-cli-project";
const pmThreadId = "rules-cli-pm";
const runId = "rules-cli-run";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

/** `bb lane-pilot rules …` through the registered CLI, on a database the PM's lesson tool filled the way it does on the hub. */
describe("bb lane-pilot rules", () => {
  it("classifies, lists by form, retires the text a mechanism holds and stores mechanism tasks for a recurring check rule", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    const lesson = async (rule: string) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_lesson", { runId, rule, audience: "writer" }, { threadId: pmThreadId, projectId }))) as { id: string; adopted: boolean };
    const piped = await lesson("Never read `$?` after a pipe (`cmd | tail` always exits 0): redirect output to a file and check the real exit code.");
    const owns = await lesson("Before answering compare every changed path with owns_paths and never_touch; if a needed path is not allowed, stop and name it.");
    expect(piped.adopted && owns.adopted).toBe(true);
    db.prepare("UPDATE lane_pilot_rule_proposal SET occurrences=4 WHERE project_id=? AND id=?").run(projectId, owns.id);

    const run = async (...args: string[]) => await harness.behavior.runCli(["rules", ...args]) as { exitCode: number; stdout?: string; stderr?: string };
    const dry = await run("classify", projectId, "--dry");
    expect(dry.stderr ?? "").toBe("");
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout!)).toMatchObject({ dry: true, classified: 2, byForm: { check: 2 } });
    expect(getRuleProposal(db, projectId, piped.id)!.form).toBeNull();

    expect(JSON.parse((await run("classify", projectId)).stdout!)).toMatchObject({ dry: false, classified: 2, undecided: 0 });
    const forms = await run("forms", projectId);
    expect(forms.stdout).toContain("check  2 rules");
    expect(forms.stdout).toContain("contract_lint");

    const promoted = await run("promote", projectId, "--repo", "/tmp/lp-repo");
    expect(promoted.stdout).toMatch(/1 new, 0 already stored, 1 recurring check\/hook rules/);
    // The ownership check lives in files the night policy keeps for the owner (judge_gates): stored, but not offered to the night.
    expect(promoted.stdout).toMatch(/owner_only +owner_only +ownership_check/);

    const plan = JSON.parse((await run("mechanize", projectId)).stdout!);
    expect(plan.held.map((row: { id: string }) => row.id)).toEqual([piped.id]);
    expect(getRuleProposal(db, projectId, piped.id)!.state).toBe("accepted");
    const applied = JSON.parse((await run("mechanize", projectId, "--apply")).stdout!);
    expect(applied.briefCharsFreed).toBeGreaterThan(50);
    expect(getRuleProposal(db, projectId, piped.id)).toMatchObject({ state: "revoked", mechanizedBy: expect.stringContaining("verification_masked_exit"), retiredReason: expect.stringContaining("mechanized by") });
    expect(getRuleProposal(db, projectId, owns.id)).toMatchObject({ state: "accepted", mechanizedBy: null });
    expect(listRuleEvents(db, projectId).find((event) => event.ruleId === piped.id)).toMatchObject({ action: "retired" });
    const after = await run("forms", projectId, "--state", "all", "--form", "check");
    expect(after.stdout).toContain("mechanized_by: contract lint verification_masked_exit");
  });
});
