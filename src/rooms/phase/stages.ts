import { TASK_KINDS } from "@lane-pilot/contracts";
import { sha256Hex } from "@lane-pilot/kit";
import type { BookPart, Drawing, Phase, PhaseRecord, PhaseStage, PlanItem, TaskFact } from "./logic";

/**
 * What each stage of a phase holds besides its gate (SMA map, Slash commands and workflows: the discuss/plan/design/execute/verify/
 * lessons workflows). Pure: the driver (server/driver.ts) and nextAction read these; nothing here touches the database or a host.
 */

/** The animator law, inline for a run without subagents (SMA: Headless: the animator law inline). */
export const ANIMATOR_LAW = "motion rows: animate transform and opacity only, 150–300 ms for UI feedback, ease-out entering and ease-in leaving, respect prefers-reduced-motion, no motion that blocks input, every animation has its end state drawn";

/** The shared drawing rules (SMA k_d_ref_design, k_d_ref_sketch): the same text the draw and check steps of lp.draw carry. */
export const DRAWING_RULES = `Drawing rules — DESIGN.md first, then the phase's CONTEXT.md/SPEC.md/PLAN.md; every screen names its states (empty, loading, error, filled) and its breakpoints; scored on six axes: hierarchy, spacing, contrast, states, brand, motion. Motion rows follow the animator law: ${ANIMATOR_LAW}. Sketch rules: light and dark themes through a data-theme attribute, variants as <screen>--<variant>.html, interactivity through the shared proto script of page-prototype, plain static HTML with no build step.`;

/** Stage rubrics: the order of work and the antipatterns that block, per stage (SMA: Discuss/Plan/Design/Execute/Verify/Lessons stage rubric). */
export const STAGE_RUBRICS: Readonly<Record<Exclude<PhaseStage, "closed">, { order: readonly string[]; antipatterns: readonly string[] }>> = {
  discussion: {
    order: ["read the goal and the roadmap row", "scout the code the goal touches", "list the gray areas and pick the ones to settle", "deep-dive each chosen area (one advisor per area)", "write CONTEXT.md: locked / free / deferred, FAQ, ADR", "name the four risks", "sign the context"],
    antipatterns: ["deciding for the owner what only he knows", "a decision without its reason", "a free area written as locked", "risks left unnamed"],
  },
  planning: {
    order: ["read CONTEXT.md and SPEC.md", "research where the context leaves a how open", "find the closest code patterns", "cut pieces: one promise, owned paths and a check each", "order them in waves by depends_on", "cover every requirement and locked decision", "independent check, up to three rounds"],
    antipatterns: ["a piece without a check that would fail without it", "a dependency inside one wave", "a requirement no piece covers", "a new file with no analog named", "replanning a closed phase"],
  },
  design: {
    order: ["read the phase (CONTEXT, SPEC, PLAN) before drawing", "pick the mode: screens, system or mixed", "gather the material (patterns, references, constraints) into MATERIAL.md", `draw by the shared drawing rules into the phase's design folder — ${DRAWING_RULES}`, "write UI-SPEC.md: the checkable points of the drawing", "a separate role reviews it", "say feasible, or the contradiction with the plan"],
    antipatterns: ["drawing before reading the plan", "a drawing without a contract a check can read", "the designer reviewing his own drawing", "motion without the animator's rules"],
  },
  execution: {
    order: ["initialize: the base commit, the drawing and contract for the writers", "issue wave by wave, the wave table into the book", "each piece through its gates (lint, base, writer, ownership, checks, plan→fact, critic)", "review each finished wave by another model", "the regression pass of earlier phases after each merge"],
    antipatterns: ["issuing the next wave before this one is accepted", "a writer editing the drawing it follows", "accepting on a model's word alone"],
  },
  verification: {
    order: ["initialize: the promises, the drawing contract points, the acceptance checks", "run every piece's checks together on main (the blind verdict)", "the live interface check where screens changed", "audit the goal against the phase goal and the drawing", "diagnose gaps, plan the gap closure, check it, revise"],
    antipatterns: ["verifying on a main that moved since", "a goal audit by the author of the work", "a passed check that proves only that a file exists"],
  },
  acceptance: {
    order: ["every acceptance line holds", "with owner.words on: UAT.md lines answered by the owner, then his word"],
    antipatterns: ["accepting with an open deferral", "accepting with a failed UAT line"],
  },
  lessons: {
    order: ["read the whole book", "what went well, what went badly, the rules to keep", "a reviewer other than the author", "the lessons into memory", "the daemon writes the conclusion (SUMMARY.md) and marks the roadmap"],
    antipatterns: ["a lesson without evidence from the book", "a review of another version of the book"],
  },
};

export const rubricLine = (stage: PhaseStage) => {
  if (stage === "closed") return "";
  const rubric = STAGE_RUBRICS[stage];
  return `Order of work: ${rubric.order.map((step, index) => `${index + 1}) ${step}`).join("; ")}. Blocking: ${rubric.antipatterns.join("; ")}.`;
};

/** Stage initialization (SMA: Phase/Plan/Discussion/Verification initialization): what to read before the stage starts. */
export function stageInit(phase: Pick<Phase, "id" | "stage" | "record">): string[] {
  const folder = `.agents/phases/${phase.id}`;
  const docs = (phase.record.context?.docs ?? []).map((doc) => doc.path);
  switch (phase.stage) {
    case "discussion": return [".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md", `${folder}/DISCUSSION.md`];
    case "planning": return [...docs, `${folder}/SPEC.md`, `${folder}/RESEARCH.md`, `${folder}/PATTERNS.md`];
    case "design": return [...docs, `${folder}/SPEC.md`, `${folder}/PLAN.md`, "DESIGN.md"];
    case "execution": return [...(phase.record.design?.drawing?.paths ?? []), `${folder}/PLAN.md`];
    case "verification": return [`${folder}/SPEC.md`, `${folder}/VALIDATION.md`, ...(phase.record.design?.drawing?.paths.filter((path) => /UI-SPEC\.md$/i.test(path)) ?? [])];
    default: return [`${folder}/BOOK.md`];
  }
}

/** Requirements and decision coverage gates: every requirement id and every locked decision named at the context is covered by a piece. */
export function coverageGaps(record: PhaseRecord): string[] {
  const items = record.plan?.items ?? [];
  const covered = new Set(items.flatMap((item) => item.covers ?? []));
  const why: string[] = [];
  const reqs = (record.context?.requirements ?? []).filter((id) => !covered.has(id));
  if (reqs.length) why.push(`requirements no piece covers: ${reqs.join(", ")} (name them in a piece's covers, or defer them in CONTEXT.md and sign again)`);
  const decisions = (record.context?.decisions ?? []).filter((id) => !covered.has(id));
  if (decisions.length) why.push(`locked decisions no piece carries out: ${decisions.join(", ")}`);
  return why;
}

/** Threat model gate: a security risk other than «none» needs a SECURITY.md among the signed context documents. */
export function threatGap(record: PhaseRecord): string | null {
  const risk = record.context?.risks?.security?.trim().toLowerCase() ?? "";
  if (!risk || /^(none|нет|no)\b/.test(risk)) return null;
  return (record.context?.docs ?? []).some((doc) => /SECURITY\.md$/i.test(doc.path)) ? null
    : `the security risk «${record.context!.risks!.security}» needs a threat model: write the phase's SECURITY.md (lane-plan template fill SECURITY --phase …) and sign it with the context`;
}

const EXISTENCE_ONLY = /^\s*(test\s+-[efsd]|ls\b|stat\b|\[\s+-[efsd])/;

/** Validation strategy: a piece whose every check only tests that something exists proves nothing about its promise. */
export function validationGaps(items: readonly PlanItem[], liveCheckOff = true): string[] {
  const why = items.filter((item) => {
    const checks = Array.isArray(item.task.verification) ? (item.task.verification as Array<{ command?: unknown }>).map((check) => String(check.command ?? "")) : [];
    return checks.length > 0 && checks.every((command) => EXISTENCE_ONLY.test(command));
  }).map((item) => `${item.id}: every check only tests that a file exists — add one that would fail without the work (VALIDATION.md)`);
  // SMA k_we_verify: visible work owes a live check — unless the project switched browser_qa off, where the acceptance line
  // names «visible work, no live check owed» and the owner decides on it there.
  if (!liveCheckOff) for (const item of items.filter(buildsScreens)) {
    const cases = Array.isArray(item.task.qa_cases) ? item.task.qa_cases.length : 0;
    const url = typeof item.task.qa_url === "string" && item.task.qa_url.trim();
    if (!cases || !url) why.push(`${item.id}: visible work owes a live check — name qa_cases and a qa_url to run them on (this project has browser_qa.enabled on; switch it off for work no browser can check)`);
  }
  return why;
}

/** The most rounds of the independent plan check before the phase stops and goes back (SMA: Up to three revision rounds, plan review convergence). */
export const PLAN_ROUNDS_MAX = 3;

const SYSTEM_PATH = /(tokens?|theme|design-system|palette|typography)\b|DESIGN\.md$/i;
const SCREEN_PATH = /\.(tsx|jsx|vue|svelte|html)$|(^|\/)(pages|screens|views|routes)\//i;
const MOTION = /\b(animat\w*|motion|transition|анимац\w*|переход\w*|движени\w*)\b/i;

/** Design mode (SMA: Mode: screens, system, mixed): what the drawing covers, from the paths the pieces own. */
export function designMode(items: readonly PlanItem[]): "screens" | "system" | "mixed" {
  const paths = items.flatMap((item) => (Array.isArray(item.task.owns_paths) ? item.task.owns_paths as string[] : []));
  const system = paths.some((path) => SYSTEM_PATH.test(path));
  const screens = paths.some((path) => SCREEN_PATH.test(path));
  return system && screens ? "mixed" : system ? "system" : "screens";
}

/** Motion rows (SMA: Animator for motion rows): pieces whose promise or title is about motion get the animator's rules. */
export const motionRows = (items: readonly PlanItem[]) =>
  items.filter((item) => MOTION.test(`${item.title} ${item.promise.given} ${item.promise.when} ${item.promise.then}`)).map((item) => item.id);

/** The rule for frequent actions (SMA k_ag_animator): carried by a piece plan only where phase.piece_notes is on. */
export const ANIMATOR_FREQUENT_RULE = "an action the person performs many times in a session (typing, row hover, list moves) is not animated";

/** A worked example of the executor rules (SMA k_d_ref_exec): red check, then files, then green, then a checkpoint —
 *  carried by a piece plan only where phase.piece_notes is on, so every other plan text stays byte-identical. */
export const EXECUTOR_RULE_EXAMPLE = [
  "Example of the executor rules: the piece owns src/queue.ts.",
  "- checks first: run `npx vitest run tests/queue.test.ts` now — it is red (enqueue missing); that red is the work's proof.",
  "- then the files: write src/queue.ts until the same command goes green; no green without the files, no files outside owns_paths.",
  "- then the checkpoint: report the green output line before the next wave is issued.",
].join("\n");

/** The heading a required drawing section is read under in UI-SPEC.md (SMA p3_requirements). */
const SECTION_HEADING: Record<string, RegExp> = {
  actions: /actions?/i, screens_states: /screens?/i, texts: /texts?|copy|microcopy/i, heuristics: /heuristics?/i,
  accessibility: /accessibilit|a11y/i, c4: /\bc4\b|container|component diagram/i, event_chain: /event[ _-]?chain|events?/i,
};

/** UI contract gate and «design contract is mandatory»: a drawing carries its checkable points (UI-SPEC.md or DESIGN.md in its
 *  paths). When the spec's text is read too (the drawing step does), every required section must have its heading in it. */
export function uiContractGap(record: PhaseRecord, specText?: string | null): string | null {
  if (record.design?.decision !== "needed" || !record.design.drawing?.paths.length) return null;
  if (!record.design.drawing.paths.some((path) => /(UI-SPEC|DESIGN)\.md$/i.test(path)))
    return "the drawing has no contract: add UI-SPEC.md with the checkable points (screens, states, breakpoints) to the drawing's paths";
  if (specText == null) return null;
  const headings = new Set(specText.split("\n").filter((line) => /^#{1,6}\s/.test(line.trim())).map((line) => line.trim()));
  const missing = (record.design.requirements ?? []).filter((section) => ![...headings].some((heading) => SECTION_HEADING[section]?.test(heading)));
  return missing.length ? `the drawing's contract misses required section(s): ${missing.join(", ")} — UI-SPEC.md needs one heading per required section` : null;
}

/** The previous contract to the archive: a drawing replaced by a new one is kept, with its hash, in the record and the book. */
export function archiveDrawing(record: PhaseRecord, next: Drawing): Drawing[] {
  const prev = record.design?.drawing;
  return prev && prev.sha256 !== next.sha256 ? [...(record.design?.archived ?? []), prev].slice(-10) : record.design?.archived ?? [];
}

/** The wave table into the journal: one row per piece of the wave as it is issued. */
const UI_FILE = /\.(html|css|scss|tsx|jsx|vue|svelte)$|(^|\/)(ui|components|pages|views)\//i;

/** Does the piece build screens: it owns a UI file. Only such a piece goes with the phase drawing. */
export function buildsScreens(item: PlanItem): boolean {
  const owns = Array.isArray(item.task.owns_paths) ? item.task.owns_paths as unknown[] : [];
  return owns.some((path) => typeof path === "string" && UI_FILE.test(path));
}

/**
 * The plan a piece goes to its writer with: the promise, then its contract as the steps. A piece used to go with the promise alone
 * (and the drawing, backend or not); with quality mode full the task's plan critic, in gate mode, blocked both pieces of the magicseo
 * replay's first wave (2026-10-31) for a plan with no steps, though the phase's own critic had approved the same contracts.
 */
export function piecePlan(phase: Pick<Phase, "id" | "title" | "record">, item: PlanItem): string {
  const task = item.task as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(task[key]) ? task[key] as unknown[] : []).map((value) =>
    typeof value === "string" ? value : value && typeof value === "object" && "command" in value ? String((value as { command: unknown }).command) : JSON.stringify(value)).filter(Boolean);
  const drawing = phase.record.design?.drawing && buildsScreens(item) ? phase.record.design.drawing.paths : [];
  const line = (label: string, values: string[]) => values.length ? `${label}: ${values.join("; ")}` : "";
  // SMA k_d_tpl_predictions / k_we_animator_inline: the forecast, the risk and the animator's law go into a piece's plan only where
  // the phase was opened with phase.piece_notes on — the plan text of every other piece is exactly what it was (the writer dispatch
  // compares plan texts to recognise a piece it already dispatched, so a text that changed with the code would be dispatched twice).
  const notes = phase.record.pieceNotes === true;
  const forecast = notes && task.forecast && typeof task.forecast === "object" ? task.forecast as { files?: number; checks_pass_first_try?: boolean; tokens?: number; minutes?: number } : null;
  const predictions = forecast ? `Predictions: ${[typeof forecast.files === "number" ? `files ${forecast.files}` : "", forecast.checks_pass_first_try === true ? "first try" : forecast.checks_pass_first_try === false ? "not first try" : "", typeof forecast.tokens === "number" ? `tokens ${forecast.tokens}` : "", typeof forecast.minutes === "number" ? `minutes ${forecast.minutes}` : ""].filter(Boolean).join(", ")}` : "";
  const contextRisks = notes ? Object.entries(phase.record.context?.risks ?? {}).filter(([, text]) => text?.trim() && !/^(none|нет|no)\b/i.test(text.trim())).map(([kind, text]) => `${kind}: ${text}`) : [];
  const risk = notes ? [task.risk ? String(task.risk) : "", Array.isArray(task.never_touch) && task.never_touch.length ? `never_touch: ${(task.never_touch as unknown[]).map(String).join(", ")}` : "", ...contextRisks].filter(Boolean).join("; ") : "";
  const steps = [
    line("1. Read first", list("read_first")),
    line("2. Run the checks, red before the work", list("verification")),
    line("3. Write the files this piece owns", list("owns_paths")),
    line("   with the interfaces", list("interfaces")),
    line("   keeping the invariants", list("invariants")),
    drawing.length ? `   the screens follow the phase drawing: ${drawing.join(", ")}` : "",
    // SMA k_we_animator_inline: a motion piece carries the animator's law inline, no subagent needed.
    notes && motionRows([item]).length ? `Motion (the animator's law): ${ANIMATOR_LAW}; ${ANIMATOR_FREQUENT_RULE}` : "",
    line("4. Done when", list("acceptance")),
    line("Out of scope", list("out_of_scope")),
    predictions,
    risk ? `Risk: ${risk}` : "",
    notes ? EXECUTOR_RULE_EXAMPLE : "",
  ].filter(Boolean);
  return [`Phase ${phase.id} «${phase.title}», wave ${item.wave}, piece ${item.id}. Promise — given ${item.promise.given}; when ${item.promise.when}; then ${item.promise.then}.`,
    "The phase's plan critic approved this contract; the steps follow it.", ...steps].join("\n").slice(0, 12000);
}

/**
 * The fields the issue lint refuses that the phase can set itself. A refusal at issue is an issue error, not a plan revision: ph_82dfc9db78
 * (2026-10-31) spent two of its three plan rounds going back through lp.plan for a missing display_title/kind/area and for qa_cases with
 * no qa_url. The phase issues every piece in quality mode full, which owes a browser check to qa_cases; with no qa_url to run it on,
 * the cases are dropped and the drop is named.
 */
export function issuedContract(phase: Pick<Phase, "id">, item: PlanItem): { task: Record<string, unknown>; dropped: string | null } {
  const task: Record<string, unknown> = { ...item.task };
  // The plan wrote the promise on the piece: the issued contract carries it, so the birth gate «a stage's piece carries its promise» holds.
  if (!task.promise) task.promise = item.promise;
  if (typeof task.display_title !== "string" || !task.display_title.trim()) task.display_title = item.title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!(TASK_KINDS as readonly unknown[]).includes(task.kind)) task.kind = "feature";
  if (typeof task.area !== "string" || !task.area.trim()) task.area = `phase:${phase.id}/${item.id}`;
  const cases = Array.isArray(task.qa_cases) ? task.qa_cases : [];
  if (cases.length && !(typeof task.qa_url === "string" && task.qa_url.trim())) {
    for (const key of ["qa_cases", "qa_env_class", "qa_dev_server"]) delete task[key];
    return { task, dropped: `${item.id}: ${cases.length} browser case(s) dropped at issue: no qa_url to run them on; the piece's verification stays its proof` };
  }
  return { task, dropped: null };
}

export function waveTable(wave: number, pieces: readonly PlanItem[], issued: Readonly<Record<string, string>>): string {
  return [`wave ${wave}:`, "| piece | task | promise |", "|---|---|---|", ...pieces.map((item) => `| ${item.id} | ${issued[item.id] ?? "—"} | ${item.promise.then.replace(/\|/g, "/")} |`)].join("\n");
}

/** UAT.md made from the plan's promises (SMA: Create UAT.md): one line per promise for the person to test and answer. With a
 *  candidate the test happens on the phase's tree — the package that will land — not on a main that does not have the work. */
export function uatText(phase: Pick<Phase, "id" | "title" | "goal" | "record">): string {
  const items = phase.record.plan?.items ?? [];
  const candidate = phase.record.candidate;
  const trees = candidate && !candidate.off ? Object.entries(candidate.trees) : [];
  const where = candidate?.landedAt ? `Test the work on main: the phase landed (${candidate.branch}).`
    : trees.length
    ? `Test the work on the phase candidate branch ${candidate!.branch}${candidate!.verified ? ` at the verified head ${Object.values(candidate!.verified).map((sha) => sha.slice(0, 12)).join(", ")}` : ""} — worktree(s): ${trees.map(([, tree]) => tree.path).join(", ")}. Do not test main: it does not have this phase's work yet.`
    : "Test the work on main.";
  // The record's lines carry the person's answers (SMA p5_uat_line): a written document renders them as they now stand.
  const byPiece = new Map((phase.record.uat?.lines ?? []).map((line) => [line.pieceId, line]));
  const mark = { open: " ", passed: "x", failed: "!" } as const;
  return [`# UAT — phase ${phase.id}: ${phase.title}`, "", `Goal: ${phase.goal}`, "", where, "",
    "One line per test, answered by its number with uat_line (pass or fail). The phase is accepted only when every line passed.", "",
    ...items.map((item, index) => { const line = byPiece.get(item.id); return `- [${line ? mark[line.state] : " "}] ${line?.n ?? index + 1}. ${item.id}: given ${item.promise.given}, when ${item.promise.when}, then ${item.promise.then}${line?.note ? ` — ${line.note}` : ""}`; }), ""].join("\n");
}

const UAT_LINE = /^- \[([ xX!])\] (.+)$/;

/** Is a UAT session open, and is it complete: the lines of UAT.md by state. */
/** One UAT line marked by its number (SMA d_phase_uat): [ ]→[x] or [!], a note appended; the other lines stay
 *  byte-equal. Null when no line carries that number. */
export function markUatLine(text: string, n: number, ok: boolean, note?: string): string | null {
  let hit = false;
  const out = text.split("\n").map((line) => {
    // A CRLF file: `.` does not match \r, so the line is matched without it and the \r goes back untouched.
    const cr = line.endsWith("\r") ? "\r" : "";
    const row = line.slice(0, line.length - cr.length).match(UAT_LINE);
    if (!row || !row[2]!.trim().startsWith(`${n}.`)) return line;
    hit = true;
    return `- [${ok ? "x" : "!"}] ${row[2]}${note?.trim() ? ` — ${note.trim().replace(/\s+/g, " ").slice(0, 600)}` : ""}${cr}`;
  });
  return hit ? out.join("\n") : null;
}

export function uatState(text: string): { lines: number; passed: number; failed: string[]; open: string[] } {
  const rows = text.split("\n").map((line) => line.trim().match(UAT_LINE)).filter((row): row is RegExpMatchArray => !!row);
  return { lines: rows.length, passed: rows.filter((row) => /[xX]/.test(row[1]!)).length, failed: rows.filter((row) => row[1] === "!").map((row) => row[2]!), open: rows.filter((row) => row[1] === " ").map((row) => row[2]!) };
}

/** The plan as a document (SMA k_wp_commit, k_t_template): title, goal, the waves table and every piece's promise,
 *  contract and coverage — the same facts the admitted plan carries. */
export function planText(phase: Pick<Phase, "id" | "title" | "goal" | "record">): string {
  return templateFill("PLAN", phase, new Map());
}

/** A prefilled phase document (SMA k_t_template): PLAN from the plan, VERIFICATION from each piece's checks and
 *  their latest result in `facts` — created from the phase's facts instead of by hand. */
export function templateFill(kind: "PLAN" | "VERIFICATION", phase: Pick<Phase, "id" | "title" | "goal" | "record">, facts: ReadonlyMap<string, TaskFact>): string {
  const items = phase.record.plan?.items ?? [];
  const waves = wavesOfPublic(items);
  if (kind === "PLAN") {
    return [`# Plan — phase ${phase.id}: ${phase.title}`, "", `Goal: ${phase.goal}`, "",
      phase.record.plan?.objective ? `Objective: ${phase.record.plan.objective}` : "", `## Waves`, "",
      ...waves.flatMap((wave) => [`### Wave ${wave}`, "", ...items.filter((item) => item.wave === wave).map((item) => [
        `- ${item.id}: given ${item.promise.given}; when ${item.promise.when}; then ${item.promise.then}`,
        `  owns: ${(Array.isArray(item.task.owns_paths) ? item.task.owns_paths : []).map(String).join(", ") || "—"}`,
        `  checks: ${(Array.isArray(item.task.verification) ? item.task.verification as Array<{ command?: unknown }> : []).map((check) => String(check?.command ?? "")).filter(Boolean).join("; ") || "—"}`,
        ...(item.covers?.length ? [`  covers: ${item.covers.join(", ")}`] : []),
      ].join("\n"))]), "",
    ].filter((line) => line !== "").join("\n");
  }
  return [`# Verification — phase ${phase.id}: ${phase.title}`, "", `Goal: ${phase.goal}`, "",
    ...items.map((item) => {
      const checks = (Array.isArray(item.task.verification) ? item.task.verification as Array<{ command?: unknown }> : []).map((check) => String(check?.command ?? "")).filter(Boolean);
      const fact = facts.get(item.id);
      const result = fact?.verification ?? fact?.state ?? "not issued";
      return `- ${item.id} (${result}): ${checks.map((command) => `\`${command}\``).join(", ") || "no checks"} — then ${item.promise.then}`;
    }), ""].join("\n");
}

const wavesOfPublic = (items: readonly PlanItem[]) => [...new Set(items.map((item) => item.wave))].sort((a, b) => a - b);

/** SPEC.md (SMA k_pl_spec): what the phase delivers — goal, requirements, locked decisions, appetite, no-gos and the
 *  ambiguity score the plan gate reads. */
export function specText(phase: Pick<Phase, "id" | "title" | "goal" | "record">): string {
  const context = phase.record.context;
  return [`# Spec — phase ${phase.id}: ${phase.title}`, "", `Goal: ${phase.goal}`, "",
    ...(phase.record.ambiguityGate === true ? [`Ambiguity: ${ambiguityScore(phase.record)}`, ""] : []),
    `## Requirements`, ...(context?.requirements?.length ? context.requirements.map((id) => `- ${id}`) : ["- none named"]), "",
    `## Locked decisions`, ...(context?.decisions?.length ? context.decisions.map((id) => `- ${id}`) : ["- none"]), "",
    `## Appetite`, context?.appetite ?? "—", "",
    `## No-gos`, ...(context?.noGos?.length ? context.noGos.map((line) => `- ${line}`) : ["- none"]), ""].join("\n");
}

/** The questions that hold the plan: blocking, asked at planning, not yet answered. The plan gate and the ambiguity score read the same list. */
export const openQuestions = (record: PhaseRecord, stage: PhaseStage) => (record.questions ?? []).filter((question) => question.stage === stage && question.blocking && !question.answer);

/** The context's ambiguity (SMA k_pl_spec), read only where phase.ambiguity_gate is on: the open planning questions over
 *  those questions plus the locked decisions, 0–1 to two decimals. Non-blocking questions and questions of other stages
 *  are not counted (they do not hold the plan either). */
export function ambiguityScore(record: PhaseRecord): number {
  const open = openQuestions(record, "planning").length;
  const total = (record.questions ?? []).filter((question) => question.stage === "planning" && question.blocking).length + (record.context?.decisions?.length ?? 0);
  return total ? Math.round((open / total) * 100) / 100 : 0;
}

/** Most contract points one phase carries (SMA k_wv_design); the book says when the list was cut. */
export const DESIGN_POINTS_MAX = 40;

/** Design contract points (SMA k_wv_design), read only where phase.design_points is on: the checklist items (`- [ ]` /
 *  `- [x]`) of UI-SPEC.md, each with a stable id from its own text, at most 40. A plain bullet is prose, not a point. */
export function designPoints(specText: string): { points: Array<{ id: string; text: string }>; total: number } {
  const seen = new Set<string>();
  const all = specText.split(/\r?\n/).map((line) => /^[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line.trim())?.[1]?.trim() ?? "").filter(Boolean)
    .map((text) => ({ id: `design_${sha256Hex(text).slice(0, 8)}`, text: text.slice(0, 300) }))
    .filter((point) => !seen.has(point.id) && !!seen.add(point.id));
  return { points: all.slice(0, DESIGN_POINTS_MAX), total: all.length };
}

/** Threat closure (SMA k_pl_security): every threat row of SECURITY.md needs a mitigation citing `file:line`, and the
 *  cited file must exist and have that line. `has` answers file-exists-and-line-exists, or null when it could not be told
 *  (the tree could not be read): such a row is `unchecked`, not a gap. */
export function threatClosureGaps(securityText: string, has: (path: string, line: number) => boolean | null): { gaps: string[]; unchecked: string[] } {
  const gaps: string[] = [], unchecked: string[] = [];
  let inThreats = false;
  for (const row of securityText.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(row.trim())) { inThreats = /threat|risk/i.test(row) && !/mitigation|must hold|what the plan/i.test(row); continue; }
    const bullet = /^-\s+(.+)$/.exec(row.trim());
    if (!bullet) continue;
    if (!inThreats) continue;
    const cite = /([^\s`"'()]+\.[a-z0-9]+):(\d{1,6})\b/i.exec(bullet[1]!);
    if (!cite) { gaps.push(`threat without a mitigation citing file:line: ${bullet[1]!.slice(0, 120)}`); continue; }
    const there = has(cite[1]!, Number(cite[2]));
    if (there === null) unchecked.push(`${cite[1]}:${cite[2]}`);
    else if (!there) gaps.push(`mitigation cites ${cite[1]}:${cite[2]}, which is not in the code: ${bullet[1]!.slice(0, 120)}`);
  }
  return { gaps, unchecked };
}

/** The daemon writes the conclusion (SMA): the phase's SUMMARY.md in the short form, from the record and the book. */
export function conclusionText(phase: Pick<Phase, "id" | "title" | "goal" | "record">, parts: readonly Pick<BookPart, "kind" | "text">[], facts: ReadonlyMap<string, TaskFact>): string {
  const items = phase.record.plan?.items ?? [];
  const returns = parts.filter((part) => part.kind === "return").map((part) => part.text);
  return [`# Summary — phase ${phase.id}: ${phase.title}`, "", `Goal: ${phase.goal}`, "", "## What was built", "",
    ...items.map((item) => `- ${item.id} (task ${facts.get(item.id)?.taskId ?? "—"}, ${facts.get(item.id)?.state ?? "not issued"}): ${item.promise.then}`), "",
    "## How it was verified", "", `- blind verdict: ${phase.record.verification?.verdict?.state ?? "—"} (${phase.record.verification?.verdict?.detail ?? ""})`,
    `- goal audit: ${phase.record.verification?.model?.state ?? "—"} by ${phase.record.verification?.model?.by ?? "—"}`,
    `- acceptance: ${(phase.record.acceptance?.lines ?? []).map((line) => `${line.ok ? "✓" : "✗"} ${line.id}`).join(", ") || "—"}`, "",
    "## Returns", "", ...(returns.length ? returns.map((text) => `- ${text}`) : ["- none"]), "",
    "## Lessons", "", phase.record.lessons?.analysis ?? phase.record.lessons?.why ?? "—", ""].join("\n");
}

const QUICK_TABLE = "## Quick Tasks Completed";

/** One line, no table break and no heading: whitespace collapsed, «|» replaced, leading «#» dropped. */
const tableCell = (text: string) => text.replace(/\s+/g, " ").replace(/\|/g, "/").trim().replace(/^#+\s*/, "");

/** The «Quick Tasks Completed» table of STATE.md (SMA k_wq_state): one row per finished quick task, header keys and body kept. Null when the project has no STATE.md: the file is never created. */
export function quickRow(previous: string | null, row: { date: string; task: string; commit: string }): string | null {
  if (previous === null) return null;
  const line = `| ${tableCell(row.date)} | ${tableCell(row.task) || "quick task"} | ${tableCell(row.commit)} |`;
  if (!previous.includes(QUICK_TABLE)) return `${previous.trimEnd()}\n\n${QUICK_TABLE}\n\n| date | task | commit |\n| --- | --- | --- |\n${line}\n`;
  const at = previous.indexOf(QUICK_TABLE);
  const rest = previous.slice(at + QUICK_TABLE.length);
  // The table ends at the next heading; the row goes after its last line (or after a fresh header when the table is still empty).
  const next = rest.search(/^#{1,6} /m);
  const table = next >= 0 ? rest.slice(0, next) : rest;
  const tail = next >= 0 ? rest.slice(next) : "";
  const rows = table.split("\n").filter((l) => l.trim().startsWith("|"));
  const body = rows.length ? [...rows, line].join("\n") : `| date | task | commit |\n| --- | --- | --- |\n${line}`;
  return `${previous.slice(0, at + QUICK_TABLE.length)}\n\n${body}\n${tail}`.replace(/\n{3,}/g, "\n\n");
}

const ROW = /^- \[([ xX])\] (\d+(?:\.\d+)*) (.+?)(?: — (.*))?$/;

/** Phase closed in the roadmap: the row of the phase gets its [x]; the text is returned unchanged when there is no such row. */
export function markRoadmap(text: string, row: string): string {
  return text.split("\n").map((line) => { const found = line.trim().match(ROW); return found && found[2] === row ? line.replace("- [ ]", "- [x]") : line; }).join("\n");
}

/** The milestone a roadmap row sits under (SMA k_we_branch): the last heading before the row, as a branch slug. */
export function milestoneOf(roadmapText: string, row: string): string | null {
  let section: string | null = null;
  for (const line of roadmapText.split("\n")) {
    const head = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (head) section = head[1]!.trim();
    const found = line.trim().match(ROW);
    if (found && found[2] === row) {
      if (!section) return null;
      const slug = section.replace(/milestone\s*/i, "").trim().toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "");
      return slug || null;
    }
  }
  return null;
}

/** The heading of the roadmap's parking lot, exactly (SMA k_c_backlog); no other heading is one. */
const BACKLOG_HEADING = "## Backlog";

/** Transition (SMA: advance to the next phase): the first open row of the roadmap. Rows that sit under the `## Backlog`
 *  heading and are numbered 999.N are the parking lot (SMA k_c_backlog): the machine never opens them, a person promotes one by
 *  renumbering it. Any other roadmap advances exactly as it always did: a real phase 999.x elsewhere is a phase, and so is a
 *  person's own row under a Backlog heading. */
export function nextRoadmapRow(text: string): { n: string; name: string; goal: string } | null {
  let parked = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) { parked = trimmed === BACKLOG_HEADING; continue; }
    const found = trimmed.match(ROW);
    // Only a 999.N row under that heading is parked: a person's own open row there is still the next phase, as it always was.
    if (found && found[1] === " " && !(parked && found[2]!.startsWith("999."))) return { n: found[2]!, name: found[3]!.trim(), goal: (found[4] ?? "").trim() };
  }
  return null;
}

/** One line of text for a roadmap row (SMA k_c_backlog): whitespace collapsed (a newline would inject rows or headings),
 *  leading `#` and `-` dropped (they would make a heading or a list item of it). */
export const oneLine = (value: string, max = 300) => value.replace(/\s+/g, " ").replace(/^[\s#>*\-]+/, "").trim().slice(0, max);

/** Owned paths that leave the checkout (SMA k_c_import): the plan gate asks only that a piece has some owns_paths, so a plan
 *  brought in from outside is checked here — no `..`, no absolute path, no drive letter, no `~`, no backslash, no empty segment. */
export function ownsPathProblems(pieceId: string, owns: unknown): string[] {
  if (!Array.isArray(owns) || !owns.length) return [`${pieceId}: no owns_paths`];
  return owns.flatMap((path) => {
    if (typeof path !== "string" || !path.trim()) return [`${pieceId}: an owns_paths entry is empty`];
    const p = path.trim();
    const bad = p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p) || p.includes("\\") || p.includes("\0") || p.replace(/\/$/, "").split("/").some((part) => part === ".." || part === "");
    return bad ? [`${pieceId}: owns_paths «${p.slice(0, 120)}» is not a path inside the checkout`] : [];
  });
}

/** The roadmap's parking lot (SMA k_c_backlog): the next 999.N row is appended under the exact heading `## Backlog`
 *  (created at the end when absent). The file's own line ends are kept. */
export function parkRoadmapRow(text: string, name: string, goal: string): { text: string; n: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let max = 0;
  for (const line of text.split("\n")) {
    const found = line.trim().match(ROW);
    if (found && found[2]!.startsWith("999.")) max = Math.max(max, Number(found[2]!.slice(4)) || 0);
  }
  const n = `999.${max + 1}`;
  const tail = oneLine(goal, 600);
  const row = `- [ ] ${n} ${oneLine(name, 200) || "untitled"}${tail ? ` — ${tail}` : ""}`;
  const lines = text.split("\n");
  const backlog = lines.findIndex((line) => line.trim() === BACKLOG_HEADING);
  if (backlog >= 0) {
    let at = backlog + 1;
    while (at < lines.length && !/^#{1,6}\s/.test(lines[at]!.trim())) at += 1;
    while (at > backlog + 1 && !lines[at - 1]!.trim()) at -= 1;
    lines.splice(at, 0, eol === "\r\n" ? `${row}\r` : row);
    return { text: lines.join("\n"), n };
  }
  const head = text.trim() ? text.replace(/\s+$/, "") + eol + eol : "";
  return { text: `${head}${BACKLOG_HEADING}${eol}${eol}${row}${eol}`, n };
}

/** A phase section of the roadmap (SMA k_t_roadmap): the row plus the indented lines under it. */
export function roadmapSection(text: string, row: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim().match(ROW)?.[2] === row);
  if (at < 0) return null;
  const out = [lines[at]!];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) break;
    if (line.trim().match(ROW) || /^#{1,6}\s/.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n");
}

/** The roadmap read together with the disk (SMA k_t_roadmap): rows ticked whose phase folder has no SUMMARY.md,
 *  phase folders no row names, and the next open row. `phases` pairs each folder with its roadmap row and SUMMARY. */
export function roadmapAnalysis(text: string, phases: readonly { id: string; row?: string; hasSummary: boolean }[]): {
  tickedWithoutSummary: string[]; foldersWithoutRow: string[]; next: { n: string; name: string; goal: string } | null } {
  const ticked = new Map<string, string>();
  for (const line of text.split("\n")) {
    const found = line.trim().match(ROW);
    if (found && found[1] !== " ") ticked.set(found[2]!, found[3]!.trim());
  }
  const inText = new Set<string>();
  for (const line of text.split("\n")) { const found = line.trim().match(ROW); if (found) inText.add(found[2]!); }
  return {
    tickedWithoutSummary: phases.filter((phase) => phase.row !== undefined && ticked.has(phase.row) && !phase.hasSummary).map((phase) => `${phase.row} ${ticked.get(phase.row!)} (phase ${phase.id})`),
    foldersWithoutRow: phases.filter((phase) => !phase.row || !inText.has(phase.row)).map((phase) => phase.id),
    next: nextRoadmapRow(text),
  };
}

/** The roadmap's numbering (SMA k_t_validate): duplicated row numbers and integer rows skipped between neighbors. */
export function roadmapNumberingGaps(text: string): string[] {
  const seen = new Set<string>();
  let prev = 0;
  const findings: string[] = [];
  for (const line of text.split("\n")) {
    const found = line.trim().match(ROW);
    if (!found) continue;
    const n = found[2]!;
    if (seen.has(n)) findings.push(`duplicate roadmap row ${n}`);
    seen.add(n);
    if (/^\d+$/.test(n)) {
      const num = Number(n);
      if (num > prev + 1) findings.push(`skipped roadmap row(s) between ${prev} and ${num}`);
      if (num > prev) prev = num;
    }
  }
  return findings;
}

/** Marks in STATE: the header keys phase and stage set, the body kept (lane-plan reads the same header). */
export function stateText(previous: string | null, marks: Record<string, string>): string {
  const today = new Date().toISOString().slice(0, 10);
  const [head, body] = previous?.startsWith("---\n") ? [previous.slice(4).split("\n---\n")[0] ?? "", previous.slice(4).split("\n---\n").slice(1).join("\n---\n")] : ["", previous ?? "\n# State\n"];
  const keys = new Map(head.split("\n").filter((line) => line.includes(":")).map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]));
  for (const [key, value] of Object.entries({ ...marks, updated: today })) keys.set(key, JSON.stringify(value));
  return `---\n${[...keys].map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

/** The block of STATE.md the command owns (SMA k_pl_state, k_t_state). Everything outside the two markers is a person's
 *  and is never read for rewriting, never moved and never dropped. */
export const STATE_BLOCK_START = "<!-- lp:state:start -->";
export const STATE_BLOCK_END = "<!-- lp:state:end -->";
/** A line the `phase state --decision/--blocker` verb added: it survives the machine's rewrite of its own block. */
export const STATE_MANUAL = "manual: ";
const STATE_ORDER = ["Position", "Decisions", "Blockers", "Session"];
const STATE_SUFFIX = / \(Lane Pilot\)$/;
const stateLine = (line: string) => line.replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim();

function stateBlockSpan(text: string): { start: number; end: number } | "broken" | null {
  const start = text.indexOf(STATE_BLOCK_START);
  if (start < 0) return null;
  const end = text.indexOf(STATE_BLOCK_END, start + STATE_BLOCK_START.length);
  return end < 0 ? "broken" : { start, end: end + STATE_BLOCK_END.length };
}

/** Sections (`## Name` and its lines) of a piece of STATE.md; a line's list dash is dropped, comments are skipped. */
function stateSections(body: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let name: string | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) { name = heading[1]!.replace(STATE_SUFFIX, ""); sections[name] = []; continue; }
    const row = raw.trim();
    if (name && row && !row.startsWith("<!--")) sections[name]!.push(row.replace(/^-\s+/, ""));
  }
  return sections;
}

/** Header keys set in place (the front matter lane-plan reads): the other header lines and the line ends stay as they were. */
function setHeaderKeys(text: string, marks: Record<string, string>): string {
  const open = /^---\r?\n/.exec(text);
  if (!open) return text;
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(open[0].length));
  if (!close) return text;
  const headEnd = open[0].length + close.index;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let head = text.slice(open[0].length, headEnd);
  for (const [key, value] of Object.entries({ ...marks, updated: new Date().toISOString().slice(0, 10) })) {
    const line = `${key}: ${JSON.stringify(value)}`;
    const own = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:.*$`, "m");
    head = own.test(head) ? head.replace(own, () => line) : head ? `${head}${eol}${line}` : line;
  }
  return text.slice(0, open[0].length) + head + text.slice(headEnd);
}

/** True when STATE.md has a front matter the header keys can be set in. */
export const stateHasHeader = (text: string | null) => !!text && /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.test(text);

/** STATE.md with the command-owned block rewritten (SMA k_pl_state, k_t_state): `sections` replace the sections of the block
 *  of the same name; the rest of the block and every byte outside it stay. No block yet: one is appended at the end (the file's
 *  line ends and its missing final newline are kept). A section a person wrote outside the block is never replaced: when the
 *  block needs the same heading it is written as `## Name (Lane Pilot)`. `marks` are set in the front matter when there is
 *  one. `keepManual` carries the lines the verb added across a rewrite. Refused when the block's start marker has no end. */
export function stateBlockText(previous: string | null, marks: Record<string, string>, sections: Record<string, string[]>, keepManual = false): { text: string } | { refused: string } {
  const existing = previous ?? "";
  const span = stateBlockSpan(existing);
  if (span === "broken") return { refused: `STATE.md has «${STATE_BLOCK_START}» without «${STATE_BLOCK_END}»: nothing is written until a person fixes it` };
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const outside = span ? existing.slice(0, span.start) + existing.slice(span.end) : existing;
  const own = span ? stateSections(existing.slice(span.start + STATE_BLOCK_START.length, span.end - STATE_BLOCK_END.length)) : {};
  const merged: Record<string, string[]> = { ...own };
  for (const [name, lines] of Object.entries(sections)) {
    const kept = keepManual ? (own[name] ?? []).filter((line) => line.startsWith(STATE_MANUAL) && !lines.includes(line)) : [];
    merged[name] = [...lines, ...kept];
  }
  const names = [...STATE_ORDER.filter((name) => name in merged), ...Object.keys(merged).filter((name) => !STATE_ORDER.includes(name))];
  const personal = new Set([...outside.matchAll(/^##\s+(.+?)\s*$/gm)].map((row) => row[1]!.toLowerCase()));
  const rows = [STATE_BLOCK_START, "<!-- Lane Pilot writes this block; the text outside it is yours and is never touched. -->",
    ...names.flatMap((name) => [personal.has(name.toLowerCase()) ? `## ${name} (Lane Pilot)` : `## ${name}`, ...merged[name]!.map(stateLine).filter(Boolean).map((line) => `- ${line}`), ""]).slice(0, -1), STATE_BLOCK_END];
  const block = rows.join(eol);
  let text: string;
  if (span) text = existing.slice(0, span.start) + block + existing.slice(span.end);
  else if (!names.length) text = previous ?? stateText(null, marks);
  else if (previous === null) text = `${stateText(null, marks)}${eol}${block}${eol}`;
  else text = existing.endsWith("\n") ? `${existing}${eol}${block}${eol}` : `${existing}${eol}${eol}${block}`;
  return { text: previous === null ? text : setHeaderKeys(text, marks) };
}

/** Two STATE.md texts that differ only by a timestamp (the `updated` key, the session's activity line) are the same state. */
export const sameStateIgnoringTime = (a: string | null, b: string) => {
  if (a === null) return false;
  const strip = (text: string) => text.replace(/^updated:.*$/gm, "").replace(/^- activity .*$/gm, "");
  return strip(a) === strip(b);
};

/** The sections of the command's own block only ({} when there is none): what the verb may extend, as opposed to what a person wrote. */
export function stateBlockSections(text: string | null): Record<string, string[]> {
  const span = text ? stateBlockSpan(text) : null;
  return text && span && span !== "broken" ? stateSections(text.slice(span.start + STATE_BLOCK_START.length, span.end - STATE_BLOCK_END.length)) : {};
}

/** STATE.md read back (SMA k_t_state): the header keys, and the `## ` sections of the command's block (of the whole body when there is no block). */
export function parseState(text: string): { marks: Record<string, string>; sections: Record<string, string[]> } {
  const open = /^---\r?\n/.exec(text);
  const close = open ? /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(open[0].length)) : null;
  const head = open && close ? text.slice(open[0].length, open[0].length + close.index) : "";
  const body = open && close ? text.slice(open[0].length + close.index + close[0].length) : text;
  const marks = Object.fromEntries(head.split(/\r?\n/).filter((line) => line.includes(":")).map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim().replace(/^"(.*)"$/, "$1")]));
  const span = stateBlockSpan(body);
  return { marks, sections: stateSections(span && span !== "broken" ? body.slice(span.start + STATE_BLOCK_START.length, span.end - STATE_BLOCK_END.length) : body) };
}

/**
 * The fingerprint of a file the text reader refuses (a PNG of the drawing, a font): read with the host's own tools, since only its hash
 * and size go into the phase record (live ph_26f65b142d: «cannot read …/design/00-kit.png: lane_pilot_read_binary_rejected» failed lp.draw).
 * Null for a path that is not a plain relative one inside the checkout.
 */
export function binaryFileCommand(path: string): string | null {
  if (!path || path.includes("\0") || path.startsWith("/") || path.split(/[\\/]/).includes("..")) return null;
  return `f='${path.replace(/'/g, `'\\''`)}'; (sha256sum -- "$f" 2>/dev/null || shasum -a 256 -- "$f") && wc -c < "$f"`;
}

/** What `binaryFileCommand` printed: the hash line, then the size. */
export function binaryFileFingerprint(stdout: string): { sha256: string; sizeBytes: number } | null {
  const lines = stdout.trim().split("\n");
  const hash = /^([0-9a-f]{64})\b/i.exec(lines[0] ?? "")?.[1];
  const size = Number((lines.at(-1) ?? "").trim());
  return hash && lines.length >= 2 && Number.isInteger(size) && size >= 0 ? { sha256: hash.toLowerCase(), sizeBytes: size } : null;
}
