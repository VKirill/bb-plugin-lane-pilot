import { classifyRuleForm, listRuleProposals, type MechanismKind, type RuleProposal, type RulesDatabase } from "@lane-pilot/run-insights";
import { taskV2Schema, type TaskV2 } from "@lane-pilot/contracts";
import { explainChange, type Tier } from "../policy";
import { mechanismFor } from "./mechanisms";

/**
 * The promotion path (SMA block 6, P2-6): a rule of form `check` or `hook` that keeps coming back is a mechanism that does not exist yet.
 * This turns it into a task contract for the night loop or self-repair: the lint, ownership check, guard or test that REFUSES the recorded
 * failure and ALLOWS a correct case. It dispatches nothing and merges nothing: rules are `night_proposes` (policy/night-policy.json), so the
 * contract waits in lane_pilot_rule_promotion until the night policy or the owner takes it. A contract that touches a file the policy keeps
 * for the owner is stored as `owner_only`, not offered to the night.
 */
export const PROMOTE_MIN_OCCURRENCES = 3;
export type PromotionWhy = "recurred" | "owner" | "confirmed";

/** Why a rule is worth a mechanism now, or null: accepted, form check/hook, not held yet, and seen ≥3 times, decided by the owner or confirmed by its trial. */
export function promotionWhy(rule: Pick<RuleProposal, "state" | "form" | "mechanizedBy" | "occurrences" | "decidedBy" | "trialState" | "rule">): PromotionWhy | null {
  if (rule.state !== "accepted" || rule.mechanizedBy) return null;
  if (rule.form !== "check" && rule.form !== "hook") return null;
  // A mechanism that already refuses the mistake fully is not asked for again: the rule is retired instead (`rules mechanize`).
  if (mechanismFor(rule.rule)?.coverage === "full") return null;
  if (rule.decidedBy === "owner") return "owner";
  if (rule.occurrences >= PROMOTE_MIN_OCCURRENCES) return "recurred";
  if (rule.trialState === "confirmed") return "confirmed";
  return null;
}

const WHY_TEXT: Record<PromotionWhy, string> = {
  recurred: "its failure was recorded at least three times",
  owner: "the owner decided it",
  confirmed: "its trial confirmed it",
};

type Template = {
  target: "lane-pilot" | "project";
  label: string;
  title: string;
  owns: (slug: string) => string[];
  read: string[];
  what: string;
};

/** Where each kind of mechanism lives in this repository, with the file to read as the worked example. */
const TEMPLATES: Record<MechanismKind, Template> = {
  contract_lint: {
    target: "lane-pilot", label: "contract lint", title: "Проверка контракта вместо правила",
    owns: (slug) => [`src/rooms/tasks/server/lint-${slug}.ts`, "src/rooms/tasks/server/contract-lint.ts", `tests/rule-mech-${slug}.test.ts`],
    read: ["src/rooms/tasks/server/lint-exit-status.ts", "tests/contract-lint-exit-status.test.ts"],
    what: "a contract lint rule: a pure function in its own file (see lint-exit-status.ts) that returns why a task contract is wrong, and a finding with a code and the concrete fix in contract-lint.ts",
  },
  ownership_check: {
    target: "lane-pilot", label: "ownership check", title: "Защита владения путями вместо правила",
    owns: (slug) => ["src/rooms/verification/ownership.ts", `tests/rule-mech-${slug}.test.ts`],
    read: ["src/rooms/verification/ownership.ts"],
    what: "an ownership check that refuses the change before an attempt is spent (a pre-edit guard or a stricter pre-finish check), with a reason that says what to do",
  },
  tool_guard: {
    target: "lane-pilot", label: "tool guard", title: "Страж вызова вместо правила",
    owns: (slug) => ["lane-stack/hooks/**", `tests/rule-mech-${slug}.test.ts`],
    read: ["lane-stack/hooks/guard_shell.py"],
    what: "a guard pattern that refuses the tool call or command the rule forbids, with a refusal that says what to do instead (owner rule: refusals name the legitimate path)",
  },
  static_test: {
    target: "project", label: "static test", title: "Тест вместо правила",
    owns: (slug) => [`tests/rule-mech-${slug}.test.ts`],
    read: [],
    what: "a test in the project's own repository that fails when the code pattern the rule forbids appears (a grep over the sources, a lock file, an architecture assertion)",
  },
};

const NEVER_TOUCH = ["policy/**", "src/rooms/policy/**", "tests/policy/**", "tests/architecture/**", "vitest.config.ts", "package.json", ".git/**"];

const shortRule = (rule: string, max: number) => { const flat = rule.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

/** The mechanism kind the classifier saw in the rule, from its recorded reason (`check/contract_lint: …`) or a fresh read of its words. */
export function mechanismKindOf(rule: Pick<RuleProposal, "rule" | "formReason">): MechanismKind {
  const recorded = /^(?:check|hook)\/(contract_lint|ownership_check|static_test|tool_guard)\b/.exec(rule.formReason ?? "")?.[1];
  return (recorded as MechanismKind | undefined) ?? classifyRuleForm(rule.rule).mechanism ?? "contract_lint";
}

export type MechanismTask = { task: TaskV2; kind: MechanismKind; target: "lane-pilot" | "project"; tier: Tier; tierReason: string; why: PromotionWhy };

/**
 * The task contract that builds the mechanism for one rule. `repoPath` is the checkout the writer works in: this plugin's for a
 * lane-pilot target, the rule's project for a project target.
 */
export function buildMechanismTask(rule: RuleProposal, input: { repoPath: string; why: PromotionWhy }): MechanismTask {
  const kind = mechanismKindOf(rule);
  const template = TEMPLATES[kind];
  const slug = rule.id.replace(/^rule_/, "").slice(0, 8);
  const owns = template.owns(slug);
  const testFile = `tests/rule-mech-${slug}.test.ts`;
  const bad = rule.examples.length ? rule.examples.map((example, index) => `  ${index + 1}. ${shortRule(example, 300)}`).join("\n") : "  (no failure text was recorded; take the case from the rule's own words)";
  const task: TaskV2 = {
    schema_version: 2,
    id: `mech-${slug}`,
    display_title: template.title,
    kind: "feature",
    area: "feature:rule-mechanism",
    title: `Mechanism for rule ${rule.id}: ${shortRule(rule.rule, 90)}`,
    risk: "medium",
    lane: "writer",
    project_cwd: input.repoPath,
    read_first: template.read,
    interfaces: ["The mechanism refuses the recorded bad case with a message that names the fix, and allows a correct case of the same kind"],
    invariants: [
      "Every contract, command or change that is allowed today stays allowed unless it is the recorded bad case",
      "The text of the rule is not edited here: it retires after the mechanism is merged",
    ],
    out_of_scope: ["Other lint rules, other guards and the policy files", "Retiring or editing the rule", "Deploying or publishing"],
    expected_outputs: [testFile],
    owns_paths: owns,
    never_touch: NEVER_TOUCH,
    depends_on: [],
    objective: [
      `Build ${template.what}.`,
      `It replaces this rule, which is only text today (${WHY_TEXT[input.why]}; form ${rule.form ?? "check"}):`,
      `  ${rule.rule}`,
      `Failures recorded for it (${rule.occurrences} times in ${rule.taskCount} tasks):`,
      bad,
      `Write ${testFile} first. It must contain at least one case built from a recorded failure above that the mechanism refuses, and at least one correct case that it allows. Run it red, then build the mechanism until it is green.`,
      template.target === "project" ? "This lives in the project's own repository: use the project's test runner; the command below is vitest and may need replacing." : "",
    ].filter(Boolean).join("\n"),
    acceptance: [
      `${testFile} feeds a case taken from a recorded failure and expects the mechanism to refuse it, naming the fix`,
      `${testFile} feeds a correct case of the same kind and expects the mechanism to allow it`,
      "The tests of the touched module pass without being edited",
    ],
    verify: "tests",
    verification: [
      { command: `npx vitest run ${testFile}`, cwd: input.repoPath },
      ...(kind === "contract_lint" ? [{ command: "npx vitest run tests/contract-lint.test.ts tests/contract-lint-empty-check.test.ts tests/contract-lint-exit-status.test.ts", cwd: input.repoPath }] : []),
    ],
  };
  taskV2Schema.parse(task);
  const verdict = explainChange({ kind: "rule_mechanize", files: owns });
  return { task, kind, target: template.target, tier: verdict.tier, tierReason: verdict.reason, why: input.why };
}

export type PromotionState = "proposed" | "owner_only" | "dispatched" | "done" | "dismissed";
export type PromotionRow = { ruleId: string; projectId: string; mechanism: MechanismKind; state: PromotionState; task: TaskV2; tier: Tier; createdAt: number; updatedAt: number };

type PromotionDb = RulesDatabase;

/**
 * Generates the contracts for the project's recurring check/hook rules and stores the new ones. A rule that already has a contract is left
 * alone whatever its state, so a dismissed proposal does not come back every night.
 */
export function proposePromotions(db: PromotionDb, projectId: string, input: { repoPath: string; now?: number }): { created: PromotionRow[]; kept: number; candidates: number } {
  const now = input.now ?? Date.now();
  const known = new Set((db.prepare("SELECT rule_id FROM lane_pilot_rule_promotion WHERE project_id=?").all(projectId) as Array<{ rule_id: string }>).map((row) => row.rule_id));
  const created: PromotionRow[] = [];
  let candidates = 0;
  for (const rule of listRuleProposals(db, projectId, { state: "accepted", limit: 500 })) {
    const why = promotionWhy(rule);
    if (!why) continue;
    candidates++;
    if (known.has(rule.id)) continue;
    const built = buildMechanismTask(rule, { repoPath: input.repoPath, why });
    const state: PromotionState = built.tier === "owner_only" ? "owner_only" : "proposed";
    db.prepare(`INSERT OR IGNORE INTO lane_pilot_rule_promotion(rule_id,project_id,mechanism,state,task_json,tier,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(rule.id, projectId, built.kind, state, JSON.stringify(built.task), built.tier, now, now);
    created.push({ ruleId: rule.id, projectId, mechanism: built.kind, state, task: built.task, tier: built.tier, createdAt: now, updatedAt: now });
  }
  return { created, kept: known.size, candidates };
}

export function listPromotions(db: PromotionDb, projectId: string): PromotionRow[] {
  return (db.prepare("SELECT rule_id, project_id, mechanism, state, task_json, tier, created_at, updated_at FROM lane_pilot_rule_promotion WHERE project_id=? ORDER BY created_at DESC, rule_id")
    .all(projectId) as Array<{ rule_id: string; project_id: string; mechanism: MechanismKind; state: PromotionState; task_json: string; tier: Tier; created_at: number; updated_at: number }>)
    .map((row) => ({ ruleId: row.rule_id, projectId: row.project_id, mechanism: row.mechanism, state: row.state, task: JSON.parse(row.task_json) as TaskV2, tier: row.tier, createdAt: row.created_at, updatedAt: row.updated_at }));
}
