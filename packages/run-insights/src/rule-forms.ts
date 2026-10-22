import type { RuleForm, RulesDatabase } from "./rules";

/**
 * SMA block 6 (P2-6, "text rules are not mechanisms"): every rule gets the FORM it should take, and a rule that a mechanism now
 * enforces records that mechanism and leaves the always-on brief. Maslov: «правила, оставшиеся текстом, нарушались; держалось только
 * то, что стало проверкой, воротами или тестом». The hub had 165 rules with an empty form.
 */
export const ruleMechanismMigrations: readonly string[] = [
  // Why the rule has its form, who set it (heuristic | jev | owner | reflection), and the mechanism (commit / test / lint code) that enforces it.
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN form_reason TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN form_by TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN mechanized_by TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN mechanized_at INTEGER`,
  // A mechanism proposal generated for a rule of form check that keeps recurring: the task contract waits here for the night loop or
  // self-repair; nothing is dispatched or merged by the generator (rules are night_proposes).
  `CREATE TABLE IF NOT EXISTS lane_pilot_rule_promotion (
    rule_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    mechanism TEXT NOT NULL,
    state TEXT NOT NULL,
    task_json TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, rule_id)
  ) WITHOUT ROWID`,
];

/** What kind of mechanism can hold a rule of form `check` or `hook`. */
export type MechanismKind = "contract_lint" | "ownership_check" | "static_test" | "tool_guard";
export type FormConfidence = "high" | "medium" | "low";
export type FormVerdict = {
  form: RuleForm;
  /** One line: the signals that decided it; kept on the rule. */
  reason: string;
  mechanism: MechanismKind | null;
  confidence: FormConfidence;
  /** False when no signal reached the bar and the rule fell back to `always`: the rules to put to Jev. */
  decided: boolean;
  scores: Record<RuleForm, number>;
};

type Signal = { id: string; form: RuleForm; weight: number; test: RegExp; mechanism?: MechanismKind; text?: string };

const NEGATION = String.raw`(?:never|do not|don't|must not|mustn't|not use|no longer|нельзя|не\s+\p{L}+|никогда)`;
const COMMAND_WORDS = String.raw`(?:git\b|deploy\.sh|\bbb\b|\brm\b|force|shell|thread|relay|lane_pilot_\w+|reminder|push|\bcurl\b|docker|sudo|--apply|\bssh\b)`;

/**
 * The signals, in the order they are listed in a verdict's reason. Weights: 3 = the text names the very thing the mechanism reads
 * (a contract field, a verification command, a migration list), 2 = the shape of the sentence points to it, 1 = a hint.
 * Tuned on the 118 accepted and proposed rules of the hub (2026-10-22) and pinned by tests/rule-forms.test.ts.
 */
const SIGNALS: Signal[] = [
  // check: the rule is about what a task contract or a verification says, or about a pattern a test can grep for.
  { id: "ownership-compare", form: "check", weight: 3, mechanism: "ownership_check", test: /(?:compare|сверя|check)[^.]{0,60}(?:changed|изменённые|изменени)[^.]{0,40}(?:owns_paths|paths)|(?:outside|вне)[^.]{0,30}owns_paths|owns_paths check|owns_paths[^.]{0,40}\bflags?\b/i },
  { id: "contract-field", form: "check", weight: 3, mechanism: "contract_lint", test: /\b(owns_paths|never_touch|expected_outputs|depends_on|read_first|display_title|contract lint)\b|task contract|writer contract|task'?s contract|контракт/i },
  { id: "verification", form: "check", weight: 3, mechanism: "contract_lint", test: /\bverification\b(?! (?:evidence|receipt))|verification step|\bnpx vitest|\bvitest run\b|\bwhole (?:test )?suite\b|full[- ]suite|\bfull suite\b/i },
  { id: "migration-order", form: "check", weight: 3, mechanism: "static_test", test: /append (?:it )?(?:ONLY )?(?:as the )?(?:last|at the end)|only append|last element of|never insert[, ]|reorder or edit an existing|appended? at the end/i },
  { id: "exit-status", form: "check", weight: 3, mechanism: "contract_lint", test: /\$\?|pipefail|exit code|exits? 0\b|always exits/i },
  { id: "same-task-must", form: "check", weight: 3, mechanism: "contract_lint", test: /(?:same task|task) must (?:also )?(?:add|own|put|include|carry)|must also (?:own|add|put|include)|every [^.]{0,60}(?:contract|task) (?:that|which)? ?[^.]{0,40}(?:add|include|carry)/i },
  { id: "code-pattern", form: "check", weight: 3, mechanism: "static_test", test: new RegExp(`${NEGATION}[^.]{0,40}(?:write|read|call|use|run|override|put|add|insert)[^.]{0,80}(?:\`|\\.vue|\\.tsx?|\\.json|nuxt\\.config|locale|scoped|process\\.env)`, "iu") },
  { id: "code-never", form: "check", weight: 2, mechanism: "static_test", test: /\bnever (?:write|call|read|strip|override|use)\b|не (?:пиши|используй)/i },
  { id: "code-context", form: "check", weight: 1, mechanism: "static_test", test: /\b(?:locale json|nuxt\.config|scoped styles?|web code|\.vue|\.tsx?|host\/plugin\.ts|ROLE_PROFILES|typecheck)\b/i },
  { id: "every-task", form: "check", weight: 2, mechanism: "contract_lint", test: /^every (?:task|writer)/i },
  { id: "add-test", form: "check", weight: 3, mechanism: "static_test", test: /\badd a test\b|test against the real/i },
  { id: "gate-words", form: "check", weight: 3, mechanism: "contract_lint", test: /\bhealthcheck\b|\bsmoke (?:url|test)\b|\bpreflight\b/i },
  { id: "scope-limit", form: "check", weight: 3, mechanism: "ownership_check", test: /\b(?:create )?only (?:the )?(?:named|requested)[^.]{0,30}file|\bunder notes\/ only|remove any changes to other paths/i },
  { id: "check-command", form: "check", weight: 3, mechanism: "contract_lint", test: /\b(?:lane pilot'?s? (?:sandboxed )?checks?|task checks?|check commands?|e2e command|give each task only)\b|\bbefore answering,? run\b|\bdo not finish while\b/i },
  { id: "gate", form: "check", weight: 2, mechanism: "contract_lint", test: /\b(?:release|integration)[- ]gate\b/i },
  { id: "named-test", form: "check", weight: 1, mechanism: "static_test", test: /\b(?:architecture|lint|typecheck|tsc|eslint|stylelint)\b/i },
  // hook: a guard on a tool call or a command.
  { id: "tool-never", form: "hook", weight: 3, mechanism: "tool_guard", test: new RegExp(`${NEGATION}[^.]{0,30}(?:run|start|push|force|delete|wake|send|call|commit|merge|deploy|hand|message|tell|put|leave)[^.]{0,80}${COMMAND_WORDS}`, "iu") },
  { id: "tool-name", form: "hook", weight: 2, mechanism: "tool_guard", test: /\blane_pilot_\w+|\bbb thread\b|\bbb \w+|\bgit (?:push|rm|reset|checkout)\b/i },
  { id: "guard-words", form: "hook", weight: 2, mechanism: "tool_guard", test: /pretooluse|guard blocks|permission (?:prompt|gate)|hook\b/i },
  // skill: procedure, craft.
  { id: "procedure-start", form: "skill", weight: 3, test: /^(?:to (?:ship|deploy|release|publish|push|start|launch|write|add)|when (?:deploying|releasing|shipping|starting|launching|a [^,]{0,40}release|merging)|before (?:launching|deploying|shipping|publishing|running any|resending|redispatching|reporting|bumping)|after (?:deploying|merging|the first)|deploy |on unexplained|if `|when [^,]{0,60}(?:release includes|fails|errors?|receipt reads|adds a request)|build and deploy)/i },
  { id: "steps", form: "skill", weight: 2, test: /(?:`[^`]{3,}`[^`]{0,160}){2,}[^.]{0,80}(?:\bthen\b|\bafter\b|\bbefore\b|→|;\s)|→|\bfirst\b[^.]{0,80}\bthen\b/i },
  { id: "craft", form: "skill", weight: 2, test: /\b(?:layout|marketing pages?|landings?|prototype|typograph\w*|section__head|responsive|ui work|shadcn|design system|restyle|visual)\b/i },
  { id: "craft-more", form: "skill", weight: 1, test: /\b(?:screenshots?|playwright|375|production build|blocks?|components?|sections?|pages?)\b/i },
  { id: "release-ops", form: "skill", weight: 1, test: /\b(?:deploy|release|rollback|prisma migration|receipt|backup)\b/i },
  // memory: a fact about the project, the machine or the owner.
  { id: "owner-fact", form: "memory", weight: 3, test: /\bthe owner (?:does not|doesn't|opens|works|wants|prefers|has|is)\b|\bowner does not take part|владелец (?:не|открывает|работает)|unless the owner asks|until the owner says|do not add github actions/i },
  { id: "env-fact", form: "memory", weight: 2, test: /\b(?:not on the (?:sandbox )?PATH|sandbox HOME|HOME differs|returns 401|WireGuard|10\.8\.\d|cached \d+ ?h|ONBOARDING_\w+|free trial|is the only|credential helper)\b/i },
  { id: "product-fact", form: "memory", weight: 3, test: /^(?:in [\w-]+, )?use [A-Z]\w+ for|^selfystudio has |free trial|every new account gets|login providers by|never for ru\b|ignore [\w-]+ data-location/i },
  { id: "dated-fact", form: "memory", weight: 3, test: /\buntil [\w. ]{0,40}\d+\.\d+\.\d+[\w. ]{0,20}deployed|\b(?:drill|fixture-note|lint probe)\b/i },
  { id: "theme-fact", form: "memory", weight: 3, test: /\bthe pokecut theme\b|\bBB places it\b/i },
  { id: "fact-sentence", form: "memory", weight: 1, test: /(?:^|[.;:] )(?:the |a )?[\w`.\/-]+(?: [\w`.\/-]+){0,4} (?:is|are|has|have|differs|lies|sits|returns|keeps|reads) (?!to\b)/i },
  // always: a stance that no mechanism can hold.
  { id: "stance", form: "always", weight: 3, test: /never end a turn|stop reasoning|take product facts|copy its approach|copy its|treat items|illustrations?, not a spec|diagnose it|only what the owner pointed|change only what the owner|do not add your own|nothing beyond|not a spec|ask first|before he has to ask|never leave him|owner points to|без вопрос/i },
];

const IMPERATIVE_START = /^(?:add|run|never|do not|don't|before|after|when|every|give|list|put|use|write|check|make|keep|take|chain|exclude|name|in|on|for|if|treat|verify|build|deploy|pick|show|sell|resolve|send|apply|set|state|call|confirm|read|stop|подключай|перед|после|назначай|не)\b/i;

const FORMS: readonly RuleForm[] = ["check", "hook", "skill", "memory", "always"];
/** Bar a non-`always` form must reach; below it the rule is undecided and falls to `always` until Jev or the owner says more. */
export const FORM_MIN_SCORE = 3;
const TIE_ORDER: readonly RuleForm[] = ["check", "hook", "skill", "memory", "always"];

export function classifyRuleForm(rule: string): FormVerdict {
  const text = rule.replace(/\s+/g, " ").trim();
  const scores: Record<RuleForm, number> = { check: 0, hook: 0, skill: 0, memory: 0, always: 0 };
  const hits: Record<RuleForm, string[]> = { check: [], hook: [], skill: [], memory: [], always: [] };
  // The mechanism is the one of the strongest signal of the winning form (the first listed on a tie), not a vote of all the weak ones.
  const strongest = new Map<RuleForm, { weight: number; mechanism: MechanismKind | undefined }>();
  for (const signal of SIGNALS) {
    if (!signal.test.test(text)) continue;
    scores[signal.form] += signal.weight;
    hits[signal.form].push(signal.id);
    if (signal.weight > (strongest.get(signal.form)?.weight ?? 0)) strongest.set(signal.form, { weight: signal.weight, mechanism: signal.mechanism });
  }
  // A fact sentence does not start with a verb of command; a rule that opens with one is an instruction, not a memory note.
  if (scores.memory > 0 && IMPERATIVE_START.test(text) && !hits.memory.some((id) => id !== "fact-sentence")) scores.memory = Math.max(0, scores.memory - 1);
  const ranked = [...FORMS].filter((form) => form !== "always").sort((a, b) => scores[b] - scores[a] || TIE_ORDER.indexOf(a) - TIE_ORDER.indexOf(b));
  const top = ranked[0]!;
  const second = ranked[1]!;
  const reachesBar = scores[top] >= FORM_MIN_SCORE;
  // `always` wins on its own stance signal unless a mechanism signal is clearly stronger.
  const alwaysWins = scores.always >= FORM_MIN_SCORE && scores.always >= scores[top];
  if (!reachesBar && !alwaysWins) {
    return { form: "always", reason: "undecided: no signal reached the bar; kept as text until Jev or the owner decides", mechanism: null, confidence: "low", decided: false, scores };
  }
  if (alwaysWins) {
    return { form: "always", reason: `always: ${hits.always.join("+")} — a stance no check, hook or note can hold`, mechanism: null, confidence: scores.always - scores[top] >= 2 ? "high" : "medium", decided: true, scores };
  }
  const mechanism = top === "check" || top === "hook" ? strongest.get(top)?.mechanism ?? null : null;
  const margin = scores[top] - scores[second];
  return {
    form: top,
    reason: `${top}${mechanism ? `/${mechanism}` : ""}: ${hits[top].join("+")}`,
    mechanism,
    confidence: margin >= 3 && scores[top] >= 4 ? "high" : margin >= 1 ? "medium" : "low",
    decided: true,
    scores,
  };
}

export type RuleFormRow = {
  id: string; projectId: string; rule: string; state: string; form: RuleForm | null; formReason: string | null; formBy: string | null;
  mechanizedBy: string | null; occurrences: number; trialState: string | null; decidedBy: string | null;
};

const ROW_SQL = `SELECT id, project_id AS projectId, rule, state, form, form_reason AS formReason, form_by AS formBy, mechanized_by AS mechanizedBy,
  occurrences, trial_state AS trialState, decided_by AS decidedBy FROM lane_pilot_rule_proposal`;

export function listRuleForms(db: RulesDatabase, projectId: string | null, states: readonly string[] = ["accepted", "proposed"]): RuleFormRow[] {
  const marks = states.map(() => "?").join(",");
  return (projectId
    ? db.prepare(`${ROW_SQL} WHERE project_id=? AND state IN (${marks}) ORDER BY occurrences DESC, last_seen_at DESC`).all(projectId, ...states)
    : db.prepare(`${ROW_SQL} WHERE state IN (${marks}) ORDER BY occurrences DESC, last_seen_at DESC`).all(...states)) as RuleFormRow[];
}

/** A form the owner or the reflection set is never overwritten by the heuristic. */
export function setRuleForm(db: RulesDatabase, projectId: string, id: string, input: { form: RuleForm; reason: string; by: "heuristic" | "jev" | "owner" | "reflection" }, now = Date.now()): boolean {
  return db.prepare(`UPDATE lane_pilot_rule_proposal SET form=?, form_reason=?, form_by=?, updated_at=?
    WHERE project_id=? AND id=? AND (form_by IS NULL OR form_by IN ('heuristic','jev') OR ? IN ('owner','reflection'))`)
    .run(input.form, input.reason.slice(0, 300), input.by, now, projectId, id, input.by).changes === 1;
}

/** Records that a mechanism now enforces the rule; the text may retire from the brief. */
export function markMechanized(db: RulesDatabase, projectId: string, id: string, mechanizedBy: string, now = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_rule_proposal SET mechanized_by=?, mechanized_at=?, updated_at=? WHERE project_id=? AND id=?")
    .run(mechanizedBy.slice(0, 300), now, now, projectId, id).changes === 1;
}

/** Rules without a form get one from the heuristic. Returns the verdicts so the caller can report the undecided rest. */
export function classifyUnformed(db: RulesDatabase, projectId: string | null, options: { all?: boolean; dry?: boolean; states?: readonly string[] } = {}, now = Date.now()): Array<{ row: RuleFormRow; verdict: FormVerdict; written: boolean }> {
  const rows = listRuleForms(db, projectId, options.states).filter((row) => options.all || !row.form);
  return rows.map((row) => {
    const verdict = classifyRuleForm(row.rule);
    // An undecided rule is written as «always» with the reason «undecided»: the text stays, as it is today, and Jev may still move it.
    const written = options.dry ? false : setRuleForm(db, row.projectId, row.id, { form: verdict.form, reason: verdict.reason, by: "heuristic" }, now);
    return { row, verdict, written };
  });
}
