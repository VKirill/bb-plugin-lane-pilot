import { PLAN_ROUNDS_MAX, ambiguityScore, coverageGaps, openQuestions, threatGap, validationGaps } from "../stages";
import { RISK_KINDS, type PhaseRecord, type PhaseStage, type PlanItem } from "./record";
import { contextSignature, planSignature } from "./signatures";
import { wordOf } from "./words";

// ---------------------------------------------------------------- gates

export type GateResult = { ok: true } | { ok: false; why: string[] };
export const gate = (why: string[]): GateResult => (why.length ? { ok: false, why } : { ok: true });

/** Discussion → planning: the context documents exist, none is empty, and they are signed (CONTEXT exists and is not empty; Context signature). */
export function discussionGate(record: PhaseRecord): GateResult {
  const docs = record.context?.docs ?? [];
  const why: string[] = [];
  if (!docs.length) why.push("no context documents: write the discussion (decisions, FAQ, ADR) to files in the project and name them");
  for (const doc of docs) if (doc.bytes === 0) why.push(`${doc.path} is empty`);
  if (docs.length && record.context?.sha !== contextSignature(docs)) why.push("the context signature does not match its documents");
  const risks = record.context?.risks ?? {};
  const unnamed = RISK_KINDS.filter((kind) => !risks[kind]?.trim());
  if (unnamed.length) why.push(`risks not named: ${unnamed.join(", ")} (name each, «none» is an answer)`);
  // SMA p1_confirm: explicit decisions on appetite and no-gos (a legacy phase has neither, its plan existed before it).
  if (!record.context?.legacy) {
    if (!record.context?.appetite?.trim()) why.push("no appetite: say how much this phase may take before any solution (time or size)");
    if (!record.context?.noGos?.some((line) => line.trim())) why.push("no-gos not named: what this phase will not do («none» is an answer)");
  }
  return gate(why);
}

/** The waves come out of depends_on: a piece depends only on pieces of the plan and of an earlier wave, and nothing loops. */
export function waveProblems(items: readonly PlanItem[]): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const why: string[] = [];
  for (const item of items) {
    const deps = Array.isArray(item.task.depends_on) ? (item.task.depends_on as unknown[]).filter((dep): dep is string => typeof dep === "string") : [];
    for (const dep of deps) {
      const other = byId.get(dep);
      if (!other) why.push(`${item.id} depends on ${dep}, which is not in the plan`);
      else if (other.wave >= item.wave) why.push(`${item.id} (wave ${item.wave}) depends on ${dep} of wave ${other.wave}: a dependency belongs to an earlier wave`);
    }
  }
  return why;
}

/** Will each piece become a work: a task with an id equal to the piece, owned paths, and a check that can run. */
export function pieceProblems(item: PlanItem): string[] {
  const why: string[] = [];
  const task = item.task;
  if (task.id !== item.id) why.push(`${item.id}: the task id must equal the piece id`);
  for (const key of ["given", "when", "then"] as const) if (!item.promise[key]?.trim()) why.push(`${item.id}: the promise has no «${key}»`);
  const owns = Array.isArray(task.owns_paths) ? task.owns_paths : [];
  if (!owns.length) why.push(`${item.id}: no owns_paths — the piece cannot become a work`);
  const checks = Array.isArray(task.verification) ? (task.verification as Array<{ command?: unknown }>) : [];
  if (!checks.length && task.verify !== "none") why.push(`${item.id}: no verification command — nothing proves the promise`);
  for (const check of checks) if (typeof check.command !== "string" || !check.command.trim()) why.push(`${item.id}: a verification item has no command`);
  // Tests are part of the task from the start (Matvey #31865): an acceptance line that names a command is proved only when that command
  // is a check of the contract (live ph_ae0a8de9db: «npm test is green» with no `npm test` among the checks failed plan-fact forever).
  const commands = checks.map((check) => String(check.command ?? ""));
  const acceptance = Array.isArray(task.acceptance) ? (task.acceptance as unknown[]).map(String) : [];
  for (const line of acceptance) for (const named of acceptanceCommands(line)) {
    if (!commands.some((command) => command.includes(named))) why.push(`${item.id}: the acceptance line «${line.slice(0, 120)}» names \`${named}\`, which is not a verification command — add it to verification or reword the line`);
  }
  return why;
}

/** Commands an acceptance line names: `code spans` that look like a command, and the usual test runners written plainly. */
export function acceptanceCommands(line: string): string[] {
  const found = new Set<string>();
  for (const match of line.matchAll(/`([^`]{2,120})`/g)) if (/^(npm|pnpm|yarn|npx|node|bun|deno|pytest|python3? -m|cargo|go|make|bash|sh|\.\/)\b/.test(match[1]!.trim())) found.add(match[1]!.trim());
  const plain = line.replace(/`[^`]*`/g, " ");
  for (const match of plain.matchAll(/\b(npm (?:test|run [\w:.-]+)|pnpm (?:test|run [\w:.-]+)|yarn (?:test|run [\w:.-]+)|node --test|pytest|cargo test|go test)\b/g)) found.add(match[1]!);
  return [...found];
}

/** The plan gate's last refusal when the project asks for the owner's word: it is the owner's to give, not a gap of the plan the machine could plan away. */
export const PLAN_WORD_GAP = "the plan awaits the owner's word (owner.words is on)";
export const INDEPENDENCE_GAP = "the plan check is not proven independent";

/** Planning → admission: every piece becomes a work, waves are computable, the plan was built on the signed context, and an independent checker approved it. */
export function planGate(record: PhaseRecord): GateResult {
  const plan = record.plan;
  // A stored plan without `items` (older or hand-edited record) is «no plan», not a crash.
  const items = plan?.items ?? [];
  if (!plan || (!items.length && !plan.alreadyMet)) return { ok: false, why: ["no plan: submit the plan's pieces (each a task-v2 contract with a Given/When/Then promise and its wave)"] };
  const why = [...items.flatMap(pieceProblems), ...waveProblems(items)];
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) why.push("two pieces have the same id");
  if (!record.context || plan.contextSha !== record.context.sha) why.push("the plan was not built on the signed context (contextSha differs): read the context documents and plan again");
  if (plan.sha !== planSignature(items, plan.contextSha)) why.push("the plan signature does not match its pieces");
  // A goal the repository already meets has no pieces to cover its requirements; the goal audit checks each of them.
  why.push(...(plan.alreadyMet ? [] : coverageGaps(record)), ...validationGaps(items, record.liveCheck !== true));
  const threat = threatGap(record);
  if (threat) why.push(threat);
  // The plan's own shape (SMA p2_record): goals and three to five pre-mortem risks. A plan the goal already meets plans nothing.
  if (!plan.alreadyMet) {
    if (!plan.objective?.trim()) why.push("the plan names no objective: its goals in one line");
    const risks = (plan.premortem ?? []).filter((risk) => risk.trim());
    if (risks.length < 3 || risks.length > 5) why.push(`the plan names ${risks.length} pre-mortem risk(s): name three to five, each a likely cause of failure a week after merge`);
  }
  if ((plan.rounds ?? 0) >= PLAN_ROUNDS_MAX && plan.critique?.decision !== "approve") why.push(`${plan.rounds} rounds of the plan check asked for changes: stop revising — return the phase to discussion with what the checker keeps finding, or close it`);
  if (!plan.critique) why.push("no independent plan check: run the plan critic (workflow lp.plan) and report its decision with the run's wfRunId");
  else if (plan.critique.decision !== "approve") why.push(`the plan checker asked for changes${plan.critique.summary ? `: ${plan.critique.summary}` : ""}`);
  else if (!plan.critique.independence?.ok) why.push(`${INDEPENDENCE_GAP}: ${plan.critique.independence?.why ?? "it names no workflow run: report the wfRunId of the lp.plan run whose plan critic approved"}`);
  why.push(...openQuestions(record, "planning").map((question) => `open question ${question.id}: ${question.text}`));
  // SMA k_pl_spec: a context whose ambiguity is above 0.5 plans nothing until the open questions are answered.
  // Only where the phase was opened with phase.ambiguity_gate on; every other record's plan gate is the one it always was.
  const ambiguity = record.ambiguityGate === true ? ambiguityScore(record) : 0;
  if (ambiguity > 0.5) why.push(`the context's ambiguity is ${ambiguity} (above 0.5): answer the open questions before planning`);
  if (record.ownerWords && wordOf(record, "planning")?.decision !== "yes") why.push(PLAN_WORD_GAP);
  return gate(why);
}

/** Every stage names the gate that lets a phase out of it (SMA: Stage without gates is refused); the test checks none is missing. */
export const STAGE_GATES: Readonly<Record<Exclude<PhaseStage, "closed">, string>> = {
  discussion: "discussionGate", planning: "planGate", design: "designGate", execution: "executionGate",
  verification: "blindVerdict", acceptance: "acceptanceLines", lessons: "lessonsNeeded",
};
