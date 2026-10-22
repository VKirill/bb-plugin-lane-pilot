import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getRuleProposal, ruleAudienceMigrations, ruleFormMigrations, ruleMechanismMigrations, ruleMigrations, ruleTrialMigrations, setRuleTrial, upsertLessonProposal, decideRuleProposal,
  type RuleProposal,
} from "@lane-pilot/run-insights";
import { taskV2Schema, type TaskV2 } from "../src/rooms/contracts";
import { lintContract, type PathKind } from "../src/rooms/tasks/server/contract-lint";
import { ROLE_PROFILES } from "../src/rooms/native-agent/helper-context";
import { MECHANISMS, applyJevForms, buildMechanismTask, jevPickForms, listPromotions, mechanismFor, promotionWhy, proposePromotions, runRulesCli } from "../src/rooms/rule-forms";

const repo = "/tmp/lane-pilot-repo";
const hub = JSON.parse(readFileSync(new URL("./fixtures/hub-rules-2026-10-22.json", import.meta.url), "utf8")) as Array<{ id: string; state: string; occurrences: number; rule: string; gold: string }>;
const hubRuleLike = (pattern: RegExp) => hub.find((row) => pattern.test(row.rule))!.rule;

const root = "/tmp/writer";
const base: TaskV2 = {
  schema_version:2, display_title:"Тестовая задача", kind:"feature", area:"feature:c", id:"c", title:"C", risk:"low", lane:"writer", project_cwd:root, read_first:[],
  interfaces:["i"], invariants:["x"], out_of_scope:["o"], expected_outputs:["src/b.ts"], owns_paths:["src/**", "tests/**"], never_touch:[], depends_on:[],
  objective:"x", acceptance:["done"], verify:"tests", verification:[{ command:"npx vitest run tests/b.test.ts", cwd:root }],
};
const lint = (task:Partial<TaskV2>, kinds:Record<string, PathKind> | null = {}) =>
  lintContract({ task:{ ...base, ...task }, workspacePath:root, hostId:"h", sandboxUnsafe:[], openTasks:[], deadDependencies:[],
    kinds:kinds ? new Map(Object.entries(kinds).map(([path, kind]) => [`${root}/${path}`, kind])) : null });
const codesOf = (result:ReturnType<typeof lint>) => [...result.errors, ...result.warnings].map((row) => row.code);

/** For every `full` contract-lint mechanism: the contract of the recorded failure the lint must refuse. A mechanism without a probe here fails the registry test. */
const BAD_CASES: Record<string, { bad: () => ReturnType<typeof lint> }> = {
  "verification-masked-exit": { bad: () => lint({ verification:[{ command:"npm test 2>&1 | tail -20", cwd:root }] }) },
  "verification-pass-with-no-tests": { bad: () => lint({ verification:[{ command:"npx vitest run tests/missing.test.ts --passWithNoTests", cwd:root }] }) },
  "filter-folder-slash": { bad: () => lint({ verification:[{ command:"npx vitest run tests/server", cwd:root }] }, { "tests/server":"directory" }) },
  "sibling-tests-owned": { bad: () => lint({ owns_paths:["src/composables/useHreflang.ts"], expected_outputs:["src/composables/useHreflang.ts"] }, { "src/composables/useHreflang.test.ts":"file" }) },
  "task-standard": { bad: () => lint({ display_title:undefined, kind:undefined }) },
  "paths-outside-project": { bad: () => lint({ owns_paths:["../other-plugin/src/x.ts"], read_first:["../other-plugin/src/x.ts"] }) },
};

describe("the mechanism registry", () => {
  it("lists only mechanisms whose tests exist", () => {
    for (const mechanism of MECHANISMS) for (const test of mechanism.tests) expect(existsSync(new URL(`../${test}`, import.meta.url)), `${mechanism.id}: ${test}`).toBe(true);
  });

  it("has a refusing mechanism behind every full contract-lint entry: the recorded bad case is refused, the sound contract is not", () => {
    const full = MECHANISMS.filter((mechanism) => mechanism.coverage === "full" && mechanism.kind === "contract_lint");
    expect(full.length).toBeGreaterThanOrEqual(5);
    for (const mechanism of full) {
      const probe = BAD_CASES[mechanism.id];
      expect(probe, `${mechanism.id} needs a recorded bad case in this test`).toBeDefined();
      const refused = codesOf(probe!.bad());
      expect(refused.some((code) => mechanism.lintCodes!.includes(code)), `${mechanism.id} must refuse its bad case with ${mechanism.lintCodes!.join("/")}; got ${refused.join(",") || "nothing"}`).toBe(true);
      expect(codesOf(lint({}, { "src/a.ts":"file" })).filter((code) => mechanism.lintCodes!.includes(code)), `${mechanism.id} must allow a sound contract`).toEqual([]);
    }
  });

  it("keeps the code roles' gitnexus in ROLE_PROFILES (the test mechanism of rule 8b7ee9)", () => {
    for (const role of ["writer", "code-repair", "night-fixer", "code-critic"] as const) expect(ROLE_PROFILES[role].mcpServers, role).toContain("gitnexus");
  });

  it("matches the hub's own words for the rules it holds, and only those", () => {
    const held = hub.map((row) => ({ row, mechanism: mechanismFor(row.rule) })).filter((entry) => entry.mechanism);
    const byMechanism = Object.fromEntries(held.map(({ row, mechanism }) => [mechanism!.id, [...(held.filter((other) => other.mechanism === mechanism).map((other) => other.row.rule.slice(0, 40)))]]));
    // Each of these rules is the text of a mistake one of the mechanisms above refuses (see the hub on 2026-10-22).
    for (const id of ["verification-masked-exit", "verification-pass-with-no-tests", "filter-folder-slash", "sibling-tests-owned", "task-standard", "paths-outside-project", "code-roles-keep-gitnexus"]) {
      expect(byMechanism[id], id).toHaveLength(1);
    }
    expect(held.filter((entry) => entry.mechanism!.coverage === "full")).toHaveLength(7);
    expect(held.filter((entry) => entry.mechanism!.coverage === "partial").length).toBeGreaterThanOrEqual(5);
    for (const entry of MECHANISMS.filter((mechanism) => mechanism.coverage === "partial")) expect(entry.gap, entry.id).toBeTruthy();
  });
});

function openDb() {
  const db = new Database(":memory:");
  for (const statement of [...ruleMigrations, ...ruleTrialMigrations, ...ruleAudienceMigrations, ...ruleFormMigrations, ...ruleMechanismMigrations]) db.exec(statement);
  return db;
}

/** An accepted rule as the hub has it, with the form the classifier gave it. */
function accept(db: Database.Database, projectId: string, rule: string, patch: { occurrences?: number; decidedBy?: "owner" | "auto"; trial?: "trial" | "confirmed"; examples?: string[]; form?: string } = {}) {
  const made = upsertLessonProposal(db, projectId, { rule, evidence: patch.examples?.[0], form: (patch.form ?? "check") as never }, 1);
  decideRuleProposal(db, projectId, made.id, { from: "proposed", to: "accepted", memoryId: `m_${made.id}` }, 2);
  db.prepare("UPDATE lane_pilot_rule_proposal SET occurrences=?, decided_by=?, trial_state=?, examples_json=? WHERE project_id=? AND id=?")
    .run(patch.occurrences ?? 1, patch.decidedBy ?? "auto", patch.trial ?? "trial", JSON.stringify(patch.examples ?? []), projectId, made.id);
  return made.id;
}

describe("the promotion path", () => {
  const OWNS = "Перед ответом сверяй все изменённые пути с `owns_paths` и `never_touch`; если нужный путь не разрешён, не меняй его и остановись с `NEEDS_HUMAN`, указав блокирующий путь.";
  const LINT = "In a task contract, list every file in expected_outputs that the change must create; verification must name a file that is missing on the base commit.";

  it("picks accepted check/hook rules that recurred, were decided by the owner or were confirmed, and not the ones a mechanism already refuses", () => {
    const db = openDb();
    const recurred = accept(db, "p", OWNS, { occurrences: 4 });
    const owner = accept(db, "p", LINT, { decidedBy: "owner" });
    const once = accept(db, "p", "In a contract, put the shared i18n file into owns_paths of one task only, then chain the rest with depends_on.", { occurrences: 1 });
    const held = accept(db, "p", hubRuleLike(/trailing slash/), { occurrences: 5 });
    const skill = accept(db, "p", "When deploying, apply the migration first, then run the receipt script.", { occurrences: 6, form: "skill" });
    const rows = (id: string) => getRuleProposal(db, "p", id)!;
    expect(promotionWhy(rows(recurred))).toBe("recurred");
    expect(promotionWhy(rows(owner))).toBe("owner");
    expect(promotionWhy(rows(once))).toBeNull();
    expect(promotionWhy(rows(held))).toBeNull();
    expect(promotionWhy(rows(skill))).toBeNull();
    setRuleTrial(db, "p", once, { trialState: "confirmed" });
    expect(promotionWhy(rows(once))).toBe("confirmed");
  });

  it("builds a valid task contract that passes Lane Pilot's own contract lint, names the recorded failures and asks for a refusing and an allowed case", () => {
    const db = openDb();
    const id = accept(db, "p", LINT, { occurrences: 4, examples: ["verification[0] command \"true\" does nothing", "no_red_before_green on a medium task"] });
    const rule: RuleProposal = getRuleProposal(db, "p", id)!;
    const built = buildMechanismTask(rule, { repoPath: repo, why: "recurred" });
    expect(() => taskV2Schema.parse(built.task)).not.toThrow();
    expect(built).toMatchObject({ kind: "contract_lint", target: "lane-pilot", tier: "night_proposes" });
    const { task } = built;
    expect(task.owns_paths).toEqual(expect.arrayContaining([expect.stringMatching(/^src\/rooms\/tasks\/server\/lint-/), "src/rooms/tasks/server/contract-lint.ts", expect.stringMatching(/^tests\/rule-mech-/)]));
    expect(task.expected_outputs[0]).toMatch(/^tests\/rule-mech-[0-9a-f]{8}\.test\.ts$/);
    expect(task.objective).toContain(rule.rule);
    expect(task.objective).toContain("does nothing");
    expect(task.acceptance.join(" ")).toMatch(/refuse/);
    expect(task.acceptance.join(" ")).toMatch(/allow/);
    expect(task.verification[0]!.command).toBe(`npx vitest run ${task.expected_outputs[0]}`);
    // Focused checks only: the whole suite is the integration gate's, and the sandbox cannot run tests/verification.
    for (const check of task.verification) expect(check.command).not.toMatch(/vitest run\s*$|tests\/verification/);
    const linted = lintContract({ task, workspacePath: repo, hostId: "h", kinds: null, sandboxUnsafe: [], openTasks: [], deadDependencies: [] });
    expect(linted.errors).toEqual([]);
    expect(task.never_touch).toEqual(expect.arrayContaining(["policy/**", "tests/architecture/**"]));
  });

  it("keeps a task that would change files the policy keeps for the owner out of the night's proposals", () => {
    const db = openDb();
    const lintRule = accept(db, "p", LINT, { occurrences: 4 });
    const ownsRule = accept(db, "p", OWNS, { occurrences: 4 });
    const result = proposePromotions(db, "p", { repoPath: repo, now: 5 });
    expect(result).toMatchObject({ candidates: 2, kept: 0 });
    const stored = Object.fromEntries(listPromotions(db, "p").map((row) => [row.ruleId, row]));
    expect(stored[lintRule]).toMatchObject({ mechanism: "contract_lint", state: "proposed", tier: "night_proposes" });
    // An ownership mechanism lives in src/rooms/verification, which night-policy.json calls judge_gates: the owner's, not the night's.
    expect(stored[ownsRule]).toMatchObject({ mechanism: "ownership_check", state: "owner_only", tier: "owner_only" });
    expect(buildMechanismTask(getRuleProposal(db, "p", ownsRule)!, { repoPath: repo, why: "recurred" }).tierReason).toContain("judge_gates");
  });

  it("stores each contract once, nothing is dispatched, and a dismissed one does not come back", () => {
    const db = openDb();
    accept(db, "p", LINT, { occurrences: 4 });
    accept(db, "q", LINT, { decidedBy: "owner" });
    expect(proposePromotions(db, "p", { repoPath: repo, now: 5 }).created).toHaveLength(1);
    expect(proposePromotions(db, "p", { repoPath: repo, now: 6 })).toMatchObject({ created: [], kept: 1 });
    db.prepare("UPDATE lane_pilot_rule_promotion SET state='dismissed' WHERE project_id='p'").run();
    expect(proposePromotions(db, "p", { repoPath: repo, now: 7 }).created).toEqual([]);
    expect(listPromotions(db, "p")[0]!.state).toBe("dismissed");
    expect(listPromotions(db, "q")).toEqual([]);
  });
});

describe("bb lane-pilot rules", () => {
  const retired: Array<[string, string, string]> = [];
  const deps = (db: Database.Database, extra: Partial<Parameters<typeof runRulesCli>[0]> = {}) => ({ db, now: () => 1000, repoPath: repo, retire: (p: string, r: string, why: string) => { retired.push([p, r, why]); }, ...extra });

  it("classifies, lists the rules by form with the mechanism, and reports the distribution", async () => {
    const db = openDb();
    const piped = accept(db, "p", hubRuleLike(/always exits 0/));
    db.prepare("UPDATE lane_pilot_rule_proposal SET form=NULL WHERE id=?").run(piped);
    upsertLessonProposal(db, "p", { rule: "The owner does not take part in editorial decisions of the factory: scenarios must decide themselves." }, 3);
    const dry = JSON.parse((await runRulesCli(deps(db), ["classify", "p", "--dry"])).stdout!);
    expect(dry).toMatchObject({ dry: true, classified: 2, byForm: { check: 1, memory: 1 } });
    expect(getRuleProposal(db, "p", piped)!.form).toBeNull();
    const done = JSON.parse((await runRulesCli(deps(db), ["classify", "p"])).stdout!);
    expect(done).toMatchObject({ dry: false, classified: 2, undecided: 0 });
    const listing = await runRulesCli(deps(db), ["forms", "p"]);
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toMatch(/check {2}1 rules/);
    expect(listing.stdout).toMatch(/memory {2}1 rules/);
    const asJson = JSON.parse((await runRulesCli(deps(db), ["forms", "p", "--form", "check", "--json"])).stdout!);
    expect(asJson.rules).toHaveLength(1);
    expect(asJson.distribution).toEqual({ check: { accepted: 1, total: 1 } });
  });

  it("records the mechanism and retires only the rules it fully refuses, dry unless --apply", async () => {
    const db = openDb();
    const held = accept(db, "p", hubRuleLike(/always exits 0/));
    const gap = accept(db, "p", OWNS_RULE());
    const dry = JSON.parse((await runRulesCli(deps(db), ["mechanize", "p"])).stdout!);
    expect(dry).toMatchObject({ applied: false, briefCharsFreed: 0 });
    expect(dry.held.map((row: { id: string }) => row.id)).toEqual([held]);
    expect(dry.partial.map((row: { id: string }) => row.id)).toEqual([gap]);
    expect(dry.partial[0].gap).toContain("PreToolUse");
    expect(retired).toEqual([]);
    const applied = JSON.parse((await runRulesCli(deps(db), ["mechanize", "p", "--apply"])).stdout!);
    expect(applied.briefCharsFreed).toBeGreaterThan(50);
    expect(retired).toEqual([["p", held, expect.stringContaining("mechanized by contract lint verification_masked_exit")]]);
    expect(getRuleProposal(db, "p", held)).toMatchObject({ mechanizedBy: expect.stringContaining("lint-exit-status.ts") });
    expect(getRuleProposal(db, "p", gap)!.mechanizedBy).toBeNull();
    // Already recorded: a second run finds nothing to do.
    expect(JSON.parse((await runRulesCli(deps(db), ["mechanize", "p", "--apply"])).stdout!).held).toEqual([]);
  });

  it("generates the promotion contracts on request and lists them", async () => {
    const db = openDb();
    accept(db, "p", LINT_RULE(), { occurrences: 4 });
    const made = await runRulesCli(deps(db), ["promote", "p", "--repo", "/tmp/elsewhere"]);
    expect(made.stdout).toMatch(/1 new, 0 already stored, 1 recurring check\/hook rules/);
    expect(listPromotions(db, "p")[0]!.task.project_cwd).toBe("/tmp/elsewhere");
    expect((await runRulesCli(deps(db), ["promote", "p", "--list"])).stdout).toMatch(/proposed +night_proposes/);
    expect((await runRulesCli(deps(db), ["promote"])).exitCode).toBe(1);
    expect((await runRulesCli(deps(db), ["nope"])).stderr).toMatch(/unknown rules operation/);
  });

  it("asks System One only for the undecided rules and takes a form only above 0.5", async () => {
    const db = openDb();
    const vague = upsertLessonProposal(db, "p", { rule: "Be careful with the thing near the other thing, always, in every case where it comes up." }, 1).id;
    const calls: string[][] = [];
    const ask = async (_state: string, questions: Record<string, { instructions: string; criteria: Record<string, string> }>) => {
      calls.push(Object.keys(questions));
      return { q0: { check: 0.1, hook: 0.05, skill: 0.7, memory: 0.1, always: 0.05 } };
    };
    const result = JSON.parse((await runRulesCli(deps(db, { ask }), ["classify", "p", "--jev"])).stdout!);
    expect(result).toMatchObject({ undecided: 1, jev: { asked: 1, moved: 1 } });
    expect(calls).toEqual([["q0"]]);
    expect(getRuleProposal(db, "p", vague)).toMatchObject({ form: "skill", formBy: "jev", formReason: "jev: p=0.70 skill" });
    const unsure = await jevPickForms([{ id: "x", rule: "r" }], async () => ({ q0: { check: 0.3, hook: 0.2, skill: 0.2, memory: 0.2, always: 0.1 } }));
    expect(unsure).toEqual([{ id: "x", form: null, p: 0.3 }]);
    const failed = await jevPickForms([{ id: "x", rule: "r" }], async () => null);
    expect(failed).toEqual([{ id: "x", form: null, p: null }]);
    expect(await applyJevForms(db, [{ id: vague, projectId: "p", rule: "r" }], async () => null)).toEqual({ asked: 1, moved: 0 });
  });
});

function LINT_RULE() {
  return "In a task contract, list every file in expected_outputs that the change must create; verification must name a file that is missing on the base commit.";
}
function OWNS_RULE() {
  return "Перед ответом сверяй все изменённые пути с `owns_paths` и `never_touch`; если нужный путь не разрешён, не меняй его и остановись с `NEEDS_HUMAN`, указав блокирующий путь.";
}
