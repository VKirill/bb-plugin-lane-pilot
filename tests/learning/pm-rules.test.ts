import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { decideRuleTrial, listRuleProposals, ruleTrialStats, upsertLessonProposal } from "@lane-pilot/run-insights";
import plugin from "../../server";
import { TARGET_SHA } from "../../src/rooms/runs/constants";
import { openDatabase, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { DEFAULT_RULE_TOKENS, RULE_COUNT_CEILING } from "../../src/rooms/contracts/rule-budget";
import { poolHasRoom, poolTokens, ruleBudget, ruleTokens, setRuleBudgets } from "../../src/rooms/learning";
import { pmResumeInstructions, pmRulesBlock, pmRulesOf, pmRulesPromptBlock, relevantPmRules } from "../../src/rooms/learning/pm-rules";
import { adoptRuleProposal, rewordAdoptedRule } from "../../src/rooms/self-repair/server/insights";
import { NOW, database } from "./helpers";

const DAY = 86_400_000;
afterEach(() => setRuleBudgets({ ...DEFAULT_RULE_TOKENS }));

/** A proposal that is accepted and on trial since `ageDays`, the way the system adopts one. */
function adopted(db: ReturnType<typeof database>, rule: string, audience: "pm" | "writer" | "both" = "pm", options: { ageDays?: number; confirm?: boolean; always?: boolean } = {}) {
  const made = upsertLessonProposal(db, "proj_1", { rule, evidence: "e", audience, always: options.always ?? false }, NOW - 40 * DAY);
  if (options.always) upsertLessonProposal(db, "proj_1", { rule, evidence: "e2", audience, always: true }, NOW - 39 * DAY);
  const row = adoptRuleProposal(db, "proj_1", made.id, NOW - (options.ageDays ?? 10) * DAY);
  if (options.confirm) db.prepare("UPDATE lane_pilot_rule_proposal SET trial_state='confirmed' WHERE id=?").run(made.id);
  return { id: made.id, row };
}
/** Rules that share no words, so the proposal store does not take one for a repeat of another. */
const word = (n: number, k: number) => `${String.fromCharCode(97 + (n % 26), 97 + Math.floor(n / 26), 97 + k)}wort`;
const distinct = (n: number) => `Always ${word(n, 0)} the ${word(n, 1)} before the ${word(n, 2)} and ${word(n, 3)} it.`;

describe("a PM rule's uses are counted (harness batch 2026-11-02)", () => {
  it("entering a PM prompt is a use, once per run or task; five clean uses confirm the rule, none in 60 days retires it", () => {
    const db = database();
    const { id } = adopted(db, "Ask the owner before a deploy to production.", "pm");
    pmRulesPromptBlock(db, "proj_1", [], ruleBudget("pm"), "pm:run_1");
    pmRulesPromptBlock(db, "proj_1", [], ruleBudget("pm"), "pm:run_1");
    expect(ruleTrialStats(db, "proj_1", id, 0)).toMatchObject({ applied: 1, appliedAccepted: 1, recurrences: [] });
    expect(pmResumeInstructions(db, "proj_1", [], "pm:run_2")).toContain("Ask the owner before a deploy");
    for (const use of ["pm:run_3", "task:t1", "task:t2"]) pmRulesPromptBlock(db, "proj_1", [], ruleBudget("pm"), use);
    const rule = listRuleProposals(db, "proj_1").find((row) => row.id === id)!;
    expect(ruleTrialStats(db, "proj_1", id, 0).applied).toBe(5);
    expect(decideRuleTrial(rule, ruleTrialStats(db, "proj_1", id, 0), Date.now())).toEqual({ action: "confirm" });
    // Shown without a use record (no `use`): nothing is counted, as before.
    const idle = adopted(db, distinct(7), "pm", { ageDays: 70 });
    pmRulesPromptBlock(db, "proj_1", [], ruleBudget("pm"));
    const idleRule = listRuleProposals(db, "proj_1").find((row) => row.id === idle.id)!;
    expect(decideRuleTrial(idleRule, ruleTrialStats(db, "proj_1", idle.id, 0), NOW)).toEqual({ action: "retire", reason: "unused" });
  });
});

describe("the budget of a pool of rules (T4)", () => {
  it("counts a rule in tokens, and a pool has room until its budget is spent", () => {
    expect(ruleTokens("abcdefgh")).toBe(2 + 3);
    expect(ruleBudget("pm")).toBe(1600);
    setRuleBudgets({ pm: 20 });
    expect(poolHasRoom([{ rule: "x".repeat(40) }], "y".repeat(8), "pm")).toBe(true);
    expect(poolHasRoom([{ rule: "x".repeat(40) }], "y".repeat(40), "pm")).toBe(false);
    expect(poolTokens([{ rule: "x".repeat(40) }])).toBe(13);
    expect(poolHasRoom(Array.from({ length: RULE_COUNT_CEILING }, () => ({ rule: "a" })), "b", "writer")).toBe(false);
  });

  it("takes more than twelve short PM rules, which the old count refused", () => {
    const db = database();
    for (let i = 0; i < 20; i++) expect(adopted(db, distinct(i)).row, `rule ${i}`).not.toBeNull();
    expect(listRuleProposals(db, "proj_1", { state: "accepted" })).toHaveLength(20);
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='cap_reached'").get()).toEqual({ n: 0 });
  });

  it("makes room for a long rule by retiring as many of the weakest rules on trial as it needs, and spares the confirmed ones", () => {
    const db = database();
    setRuleBudgets({ pm: 60 });
    const keep = adopted(db, "Confirmed rule that stays in force for good reasons.", "pm", { confirm: true });
    const a = adopted(db, "Always sweep the kitchen before the lunch and mop it.");
    const b = adopted(db, "Prefer purple gadgets over yellow widgets in mockups.");
    expect(keep.row && a.row && b.row).toBeTruthy();
    const long = adopted(db, "Quarterly invoices require countersigned approval from finance before transmission to customers, otherwise archive drafts quietly.", "pm", { ageDays: 0 });
    expect(long.row).not.toBeNull();
    const state = (id: string) => (db.prepare("SELECT state FROM lane_pilot_rule_proposal WHERE id=?").get(id) as { state: string }).state;
    expect([state(keep.id), state(a.id), state(b.id), state(long.id)]).toEqual(["accepted", "revoked", "revoked", "accepted"]);
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='retired'").get()).toEqual({ n: 2 });
  });

  it("changes nothing when even the weakest cannot make room, and says why", () => {
    const db = database();
    setRuleBudgets({ pm: 40 });
    const fresh = adopted(db, "Fresh trial rule about alpha modules, young.", "pm", { ageDays: 1 });
    const confirmed = adopted(db, "Confirmed rule about bravo modules that stays.", "pm", { confirm: true });
    const refused = adopted(db, "Another rule about charlie modules that does not fit anywhere.", "pm", { ageDays: 0 });
    expect(refused.row).toBeNull();
    const state = (id: string) => (db.prepare("SELECT state FROM lane_pilot_rule_proposal WHERE id=?").get(id) as { state: string }).state;
    expect([state(fresh.id), state(confirmed.id), state(refused.id)]).toEqual(["accepted", "accepted", "proposed"]);
    const event = db.prepare("SELECT detail FROM lane_pilot_rule_event WHERE action='cap_reached'").get() as { detail: string };
    expect(event.detail).toMatch(/tokens\) in force, none on trial old enough to replace/);
  });

  it("keeps the PM pool and the writer pool apart", () => {
    const db = database();
    setRuleBudgets({ pm: 30, writer: 400 });
    adopted(db, "A PM rule that fills the small PM pool for good.", "pm", { confirm: true });
    expect(adopted(db, "Another PM rule that cannot fit next to it at all.", "pm", { ageDays: 0 }).row).toBeNull();
    expect(adopted(db, "A writer rule that has its own much larger pool.", "writer").row).not.toBeNull();
  });

  it("a rewrite the core has no room for keeps the old wording and says so, instead of failing the night's apply step", () => {
    const db = database();
    const made = adopted(db, "Run the spec next to the file before you answer.");
    expect(made.row).not.toBeNull();
    db.prepare("INSERT INTO lane_pilot_project_settings (project_id, key, value, updated_at) VALUES ('proj_1','memory.core_budget','5',?)").run(NOW);
    expect(rewordAdoptedRule(db, "proj_1", made.id, "Run the spec next to the file and read its fixture before you answer, every time.", "trial recurred")).toBe(false);
    expect(db.prepare("SELECT rule, state FROM lane_pilot_rule_proposal WHERE id=?").get(made.id)).toMatchObject({ rule: "Run the spec next to the file before you answer.", state: "accepted" });
    expect(db.prepare("SELECT detail FROM lane_pilot_rule_event WHERE action='cap_reached'").get()).toMatchObject({ detail: expect.stringContaining("new wording") });
  });

  it("reports a full core memory as a full pool instead of failing the tool", () => {
    const db = database();
    db.prepare("INSERT INTO lane_pilot_project_settings (project_id, key, value, updated_at) VALUES ('proj_1','memory.core_budget','5',?)").run(NOW);
    const made = upsertLessonProposal(db, "proj_1", { rule: "A rule too big for a core budget of five tokens at all.", audience: "pm" });
    expect(adoptRuleProposal(db, "proj_1", made.id)).toBeNull();
    expect(db.prepare("SELECT detail FROM lane_pilot_rule_event WHERE action='cap_reached'").get()).toMatchObject({ detail: expect.stringContaining("core memory budget") });
  });
});

describe("the PM's rules block (T4)", () => {
  it("lists the rules for the PM and both, never the writer's, in the order always, confirmed, trial", () => {
    const db = database();
    adopted(db, "Writers only: format with prettier.", "writer");
    adopted(db, "Trial rule: ask the copywriter, not the owner.", "pm", { ageDays: 2 });
    adopted(db, "Confirmed rule: never deploy on Friday evening.", "both", { confirm: true });
    adopted(db, "Always rule: answer the owner in Russian.", "pm", { always: true });
    const rules = pmRulesOf(db, "proj_1");
    expect(rules.map((rule) => rule.rule)).toEqual(["Always rule: answer the owner in Russian.", "Confirmed rule: never deploy on Friday evening.", "Trial rule: ask the copywriter, not the owner."]);
    const block = pmRulesBlock(rules, 1600);
    expect(block).toMatchObject({ shown: 3, hidden: 0 });
    expect(block.text).toContain("- Always rule: answer the owner in Russian.");
    expect(block.text).not.toContain("prettier");
  });

  it("fits the budget without cutting a rule and says how many did not fit", () => {
    const db = database();
    for (let i = 0; i < 6; i++) adopted(db, distinct(i), "pm", { ageDays: 10 - i });
    const rules = pmRulesOf(db, "proj_1");
    const block = pmRulesBlock(rules, 80);
    expect(block.shown).toBeGreaterThan(0);
    expect(block.shown).toBeLessThan(6);
    expect(block.hidden).toBe(6 - block.shown);
    expect(block.tokens).toBeLessThanOrEqual(80);
    expect(block.text).toContain(`${block.hidden} more rule`);
    expect(block.text).toContain('op:"rules"');
    expect(pmRulesBlock(rules, 5)).toMatchObject({ text: "", shown: 0 });
    expect(pmRulesBlock([], 1600).text).toBe("");
  });

  it("cuts the resume block on a rule boundary, never through a rule", () => {
    const db = database();
    for (let i = 0; i < 9; i++) adopted(db, `${"q".repeat(500)} endrule${i}.`);
    const text = pmResumeInstructions(db, "proj_1", []) ?? "";
    const lines = text.split("\n").filter((line) => line.startsWith("- "));
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(9);
    for (const line of lines) expect(line).toMatch(/endrule\d+\.$/);
  });

  it("is empty for a project with no PM rule, and honours the sections of a run", () => {
    const db = database();
    expect(pmRulesPromptBlock(db, "proj_1", [], 1600)).toBe("");
    adopted(db, "A rule for the whole project, every run.", "pm");
    upsertLessonProposal(db, "proj_1", { rule: "A rule only for the clients section of the project.", audience: "pm", scope: ["section:clients"] });
    db.prepare("UPDATE lane_pilot_rule_proposal SET state='proposed' WHERE rule LIKE '%clients section%'").run();
    const second = adopted(db, "A rule only for the clients section, in force.", "pm");
    db.prepare("UPDATE lane_pilot_rule_proposal SET scope_json='[\"section:clients\"]' WHERE id=?").run(second.id);
    expect(pmRulesOf(db, "proj_1", []).map((rule) => rule.rule)).toEqual(["A rule for the whole project, every run."]);
    expect(pmRulesOf(db, "proj_1", ["section:clients"])).toHaveLength(2);
    expect(pmRulesPromptBlock(db, "proj_1", [], 1600)).toContain("whole project");
  });

  it("applies a path selector only when the caller passes the task paths", () => {
    const db = database();
    const row = adopted(db, "Read the verification room before changing its checks.");
    db.prepare("UPDATE lane_pilot_rule_proposal SET scope_json=? WHERE id=?").run(JSON.stringify(["verification"]), row.id);
    expect(pmRulesOf(db, "proj_1", ["section:a"]).map((rule) => rule.id)).not.toContain(row.id);
    expect(pmRulesOf(db, "proj_1", ["section:a"], ["src/rooms/memory/store.ts"]).map((rule) => rule.id)).not.toContain(row.id);
    expect(pmRulesOf(db, "proj_1", ["section:a"], ["src/rooms/verification/check.ts"]).map((rule) => rule.id)).toContain(row.id);
    expect(pmResumeInstructions(db, "proj_1", ["section:a"]) ?? "").not.toContain("verification room");
  });

  it("picks the rules that apply to a text by rule, with no model: always-rules, general rules and shared words stay", () => {
    const rules = [
      { rule: "Before deploying the service run the deploy drill and read its report." },
      { rule: "Reports to the owner are written in Russian, short, without filler words." },
      { rule: "Be careful." },
      { rule: "Keep invoices out of the dashboard exports.", always: true },
      { rule: "Translation files stay sorted alphabetically by key.", cue: "i18n locale" },
    ];
    const picked = relevantPmRules(rules, "deploy the new version of the service").map((rule) => rule.rule);
    expect(picked).toEqual(["Before deploying the service run the deploy drill and read its report.", "Be careful.", "Keep invoices out of the dashboard exports."]);
    expect(relevantPmRules(rules, "add a locale file for German").map((rule) => rule.rule)).toContain("Translation files stay sorted alphabetically by key.");
    // nothing to compare with: every rule is kept (a missed rule costs more than an extra line)
    expect(relevantPmRules(rules, "  ")).toHaveLength(5);
    expect(relevantPmRules(rules, "ok")).toHaveLength(5);
  });
});

// Audit 2026-10-08 (map of memory, item 3): rules for the PM never reached the PM. They are in its starting prompt now.
describe("the PM's starting prompt carries the rules", () => {
  const projectId = "proj_rules";
  let dispose: (() => Promise<void> | void) | null = null;
  afterEach(async () => { await dispose?.(); dispose = null; });

  async function startPm(prepare: (db: ReturnType<typeof openDatabase>) => void) {
    const spawns: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        hosts: { list: async () => [] },
        projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host-mini", path: "/tmp/fixture" }] }) },
        environments: { get: async () => ({ id: "env_live", projectId, hostId: "host-mini", path: "/tmp/fixture" }), listProviders: async () => [{ id: "project-checkout" }] },
        threads: {
          getPluginMetadata: async () => ({ role: "user" }), get: async () => ({ status: "idle" }) as never, listRunning: async () => [], stop: async () => undefined,
          spawn: async (input: unknown) => { spawns.push(input as unknown as Record<string, unknown>); return { id: "pm-rules", environmentId: "env_live" } as never; },
        },
      } as never,
      experimental_callHostRpc: ((call: { method: string }) => {
        if (call.method === "detect") return { hostId: "host-test", laneStack: { present: true, version: "1.39.0", sourceSha: "sha" }, openCode: { present: false, version: null }, workspace: { path: "/tmp/pm", present: true }, targetSha: TARGET_SHA, matchesTarget: true, scenario: "S2" };
        if (call.method === "coexistenceInventory") return { schemaVersion: 1, hostId: "host-test", targetSha: TARGET_SHA, managers: [{ manager: "agents-marker", path: "/tmp/install.json", installed: true, configured: true, loaded: null, compatible: true, modified: null, version: "1", sourceSha: "sha", sha256: "a".repeat(64), owner: "user", decision: "reuse", capabilities: ["threads.spawn"], missingCapabilities: [], evidence: [] }] };
        throw new Error("host offline");
      }) as never,
    });
    Object.assign(bb.agents, { experimental_vkCompiledMainAgent: () => ({ persist: true, bridgeAgentOptions: true, requiredMarker: true, snapshotDigest: true, providerIds: ["claude-code"] }) });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-saved", writerProviderId: "codex", writerModel: "codex-test" });
    prepare(db);
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    await harness.behavior.callRpc("activate_pm", {
      projectId, sourceThreadId: null, agentId: "dev-orchestrator",
      snapshot: { status: "ready", scope: { kind: "new-thread", projectId }, projectId, providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium",
        environment: { kind: "provisioning", type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host-mini" } },
        environmentRequest: { type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host-mini" }, inputs: { projectSourceId: "src_fixture" } },
        environmentProvenance: { projectId, sectionId: null, hostId: "host-mini", path: "/tmp/fixture", projectSourceId: "src_fixture" } },
    });
    return String(spawns[0]?.prompt ?? "");
  }

  it("appends the project's PM rules after the role, and nothing for a writer's rule", async () => {
    const prompt = await startPm((db) => {
      const made = upsertLessonProposal(db, projectId, { rule: "Never ask the owner about technical defects; send them to a specialist.", audience: "pm" });
      adoptRuleProposal(db, projectId, made.id);
      const writers = upsertLessonProposal(db, projectId, { rule: "Format every file with prettier before the report.", audience: "writer" });
      adoptRuleProposal(db, projectId, writers.id);
    });
    expect(prompt).toMatch(/Wait for the user's task/);
    expect(prompt).toContain("Rules the owner taught in this project");
    expect(prompt).toContain("- Never ask the owner about technical defects; send them to a specialist.");
    expect(prompt).not.toContain("prettier");
    expect(prompt.indexOf("Wait for the user's task")).toBeLessThan(prompt.indexOf("Rules the owner taught"));
  });

  it("adds nothing for a project without PM rules", async () => {
    expect(await startPm(() => undefined)).not.toContain("Rules the owner taught");
  });
});

describe("an always-on rule needs a repeat before trial (arXiv #14)", () => {
  const db = database();
  it("one sighting waits, the repeat adopts", () => {
    const made = upsertLessonProposal(db, "proj_1", { rule: "Always run migrations from the repo root only.", evidence: "one failure", always: true });
    expect(adoptRuleProposal(db, "proj_1", made.id)).toBeNull();
    upsertLessonProposal(db, "proj_1", { rule: "Always run migrations from the repo root only.", evidence: "second failure", always: true });
    expect(adoptRuleProposal(db, "proj_1", made.id)).not.toBeNull();
  });
});
