import { TASK_KINDS } from "@lane-pilot/contracts";
import { sha256Hex } from "@lane-pilot/kit";
import type { BookPart, Drawing, Phase, PhaseRecord, PhaseStage, PlanItem, TaskFact } from "./logic";

/**
 * What each stage of a phase holds besides its gate (SMA map, Slash commands and workflows: the discuss/plan/design/execute/verify/
 * lessons workflows). Pure: the driver (server/driver.ts) and nextAction read these; nothing here touches the database or a host.
 */

/** Stage rubrics: the order of work and the antipatterns that block, per stage (SMA: Discuss/Plan/Design/Execute/Verify/Lessons stage rubric). */
export const STAGE_RUBRICS: Readonly<Record<Exclude<PhaseStage, "closed">, { order: readonly string[]; antipatterns: readonly string[] }>> = {
  discussion: {
    order: ["read the goal and the roadmap row", "scout the code the goal touches", "list the gray areas and pick the ones to settle", "deep-dive each chosen area (one advisor per area)", "write CONTEXT.md: locked / free / deferred, FAQ, ADR", "name the four risks", "sign the context"],
    antipatterns: ["deciding for the owner what only he knows", "a decision without its reason", "a free area written as locked", "risks left unnamed"],
  },
  planning: {
    order: ["read CONTEXT.md and SPEC.md", "research where the context leaves a how open", "find the closest code patterns", "cut pieces: one promise, owned paths and a check each", "order them in waves by depends_on", "cover every requirement and locked decision", "independent check, up to three rounds"],
    antipatterns: ["a piece without a check that would fail without it", "a dependency inside one wave", "a requirement no piece covers", "replanning a closed phase"],
  },
  design: {
    order: ["read the phase (CONTEXT, SPEC, PLAN) before drawing", "pick the mode: screens, system or mixed", "gather the material: brand, DESIGN.md, the screens that exist", "draw by the shared sketch rules into the phase's design folder", "write UI-SPEC.md: the checkable points of the drawing", "a separate role reviews it", "say feasible, or the contradiction with the plan"],
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

/** The animator law, inline for a run without subagents (SMA: Headless: the animator law inline). */
export const ANIMATOR_LAW = "motion rows: animate transform and opacity only, 150–300 ms for UI feedback, ease-out entering and ease-in leaving, respect prefers-reduced-motion, no motion that blocks input, every animation has its end state drawn; an action the person performs many times in a session (typing, row hover, list moves) is not animated";

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
  // SMA k_d_tpl_predictions: the forecast and the risk are stated in the plan before the work; scoreForecast weighs them after.
  const forecast = task.forecast && typeof task.forecast === "object" ? task.forecast as { files?: number; checks_pass_first_try?: boolean; tokens?: number; minutes?: number } : null;
  const predictions = forecast ? `Predictions: ${[typeof forecast.files === "number" ? `files ${forecast.files}` : "", forecast.checks_pass_first_try === true ? "first try" : forecast.checks_pass_first_try === false ? "not first try" : "", typeof forecast.tokens === "number" ? `tokens ${forecast.tokens}` : "", typeof forecast.minutes === "number" ? `minutes ${forecast.minutes}` : ""].filter(Boolean).join(", ")}` : "";
  const contextRisks = Object.entries(phase.record.context?.risks ?? {}).filter(([, text]) => text?.trim() && !/^(none|нет|no)\b/i.test(text.trim())).map(([kind, text]) => `${kind}: ${text}`);
  const risk = [task.risk ? String(task.risk) : "", Array.isArray(task.never_touch) && task.never_touch.length ? `never_touch: ${(task.never_touch as unknown[]).map(String).join(", ")}` : "", ...contextRisks].filter(Boolean).join("; ");
  const steps = [
    line("1. Read first", list("read_first")),
    line("2. Run the checks, red before the work", list("verification")),
    line("3. Write the files this piece owns", list("owns_paths")),
    line("   with the interfaces", list("interfaces")),
    line("   keeping the invariants", list("invariants")),
    drawing.length ? `   the screens follow the phase drawing: ${drawing.join(", ")}` : "",
    // SMA k_we_animator_inline: a motion piece carries the animator's law inline, no subagent needed.
    motionRows([item]).length ? `Motion (the animator's law): ${ANIMATOR_LAW}` : "",
    line("4. Done when", list("acceptance")),
    line("Out of scope", list("out_of_scope")),
    predictions,
    risk ? `Risk: ${risk}` : "",
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
    const row = line.match(UAT_LINE);
    if (!row || !row[2]!.trim().startsWith(`${n}.`)) return line;
    hit = true;
    return `- [${ok ? "x" : "!"}] ${row[2]}${note?.trim() ? ` — ${note.trim().slice(0, 600)}` : ""}`;
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
    `Ambiguity: ${ambiguityScore(phase.record)}`, "",
    `## Requirements`, ...(context?.requirements?.length ? context.requirements.map((id) => `- ${id}`) : ["- none named"]), "",
    `## Locked decisions`, ...(context?.decisions?.length ? context.decisions.map((id) => `- ${id}`) : ["- none"]), "",
    `## Appetite`, context?.appetite ?? "—", "",
    `## No-gos`, ...(context?.noGos?.length ? context.noGos.map((line) => `- ${line}`) : ["- none"]), ""].join("\n");
}

/** The context's ambiguity (SMA k_pl_spec): open questions over all questions plus locked decisions, 0–1 to two decimals. */
export function ambiguityScore(record: PhaseRecord): number {
  const questions = record.questions ?? [];
  const open = questions.filter((question) => !question.answer).length;
  const total = questions.length + (record.context?.decisions?.length ?? 0);
  return total ? Math.round((open / total) * 100) / 100 : 0;
}

/** Design contract points (SMA k_wv_design): the checkable items of UI-SPEC.md — every checkbox or bullet under a
 *  heading, each with a stable id from its own text. */
export function designPoints(specText: string): Array<{ id: string; text: string }> {
  return specText.split("\n").map((line) => /^- \[[ xX!]?\]\s*(.+)$/.exec(line.trim())?.[1] ?? /^-\s+(.+)$/.exec(line.trim())?.[1] ?? null)
    .filter((item): item is string => !!item)
    .map((item) => item.trim()).filter(Boolean)
    .map((item) => ({ id: `design_${sha256Hex(item).slice(0, 8)}`, text: item }));
}

/** Threat closure (SMA k_pl_security): every threat row of SECURITY.md needs a mitigation citing `file:line`, and the
 *  cited file must exist and have that line. `has` answers file-exists-and-line-exists; the open rows are returned. */
export function threatClosureGaps(securityText: string, has: (path: string, line: number) => boolean): string[] {
  const gaps: string[] = [];
  let inThreats = false;
  for (const row of securityText.split("\n")) {
    if (/^#{1,6}\s/.test(row.trim())) { inThreats = /threat|risk/i.test(row) && !/mitigation|must hold|what the plan/i.test(row); continue; }
    const bullet = /^-\s+(.+)$/.exec(row.trim());
    if (!bullet) continue;
    if (!inThreats) continue;
    const cite = /([^\s`"'()]+\.[a-z0-9]+):(\d{1,6})\b/i.exec(bullet[1]!);
    if (!cite) { gaps.push(`threat without a mitigation citing file:line: ${bullet[1]!.slice(0, 120)}`); continue; }
    if (!has(cite[1]!, Number(cite[2]))) gaps.push(`mitigation cites ${cite[1]}:${cite[2]}, which is not in the code: ${bullet[1]!.slice(0, 120)}`);
  }
  return gaps;
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

/** Transition (SMA: advance to the next phase): the first open row of the roadmap. The parking lot (999.*) is never
 *  opened by the machine (SMA k_c_backlog): it is promoted by a person, which renumbers it out of the 999s. */
export function nextRoadmapRow(text: string): { n: string; name: string; goal: string } | null {
  for (const line of text.split("\n")) {
    const found = line.trim().match(ROW);
    if (found && found[1] === " " && !found[2]!.startsWith("999.")) return { n: found[2]!, name: found[3]!.trim(), goal: (found[4] ?? "").trim() };
  }
  return null;
}

/** The roadmap's parking lot (SMA k_c_backlog): the next 999.N row is appended under `## Backlog` (created when absent). */
export function parkRoadmapRow(text: string, name: string, goal: string): { text: string; n: string } {
  let max = 0;
  for (const line of text.split("\n")) {
    const found = line.trim().match(ROW);
    if (found && found[2]!.startsWith("999.")) max = Math.max(max, Number(found[2]!.slice(4)) || 0);
  }
  const n = `999.${max + 1}`;
  const row = `- [ ] ${n} ${name.trim()}${goal.trim() ? ` — ${goal.trim()}` : ""}`;
  const lines = text.split("\n");
  const backlog = lines.findIndex((line) => /^#{1,6}\s+backlog\b/i.test(line.trim()));
  if (backlog >= 0) {
    let at = backlog + 1;
    while (at < lines.length && !/^#{1,6}\s/.test(lines[at]!.trim())) at += 1;
    while (at > backlog + 1 && !lines[at - 1]!.trim()) at -= 1;
    lines.splice(at, 0, row);
    return { text: lines.join("\n"), n };
  }
  return { text: `${text.replace(/\s+$/, "")}\n\n## Backlog\n\n${row}\n`, n };
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

/** Marks in STATE: the header keys phase and stage set, the body kept (lane-plan reads the same header). `sections`
 *  replace the command-owned sections of the body (SMA k_pl_state): a `## <name>` block's lines are rewritten, the
 *  rest of the body survives. */
export function stateText(previous: string | null, marks: Record<string, string>, sections?: Record<string, string[]>): string {
  const today = new Date().toISOString().slice(0, 10);
  const [head, before] = previous?.startsWith("---\n") ? [previous.slice(4).split("\n---\n")[0] ?? "", previous.slice(4).split("\n---\n").slice(1).join("\n---\n")] : ["", previous ?? "\n# State\n"];
  const keys = new Map(head.split("\n").filter((line) => line.includes(":")).map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]));
  for (const [key, value] of Object.entries({ ...marks, updated: today })) keys.set(key, JSON.stringify(value));
  let body = before;
  for (const [name, lines] of Object.entries(sections ?? {})) body = replaceStateSection(body, name, lines);
  return `---\n${[...keys].map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

const STATE_HEADING = /^##\s+(.+?)\s*$/;

function replaceStateSection(body: string, name: string, lines: string[]): string {
  const rows = body.split("\n");
  const at = rows.findIndex((row) => STATE_HEADING.exec(row)?.[1]?.toLowerCase() === name.toLowerCase());
  const block = [`## ${name}`, ...lines];
  if (at < 0) return `${body.replace(/\s+$/, "")}\n\n${block.join("\n")}\n`;
  let end = at + 1;
  while (end < rows.length && !STATE_HEADING.test(rows[end]!)) end += 1;
  return [...rows.slice(0, at), ...block, "", ...rows.slice(end)].join("\n");
}

/** STATE.md read back (SMA k_t_state): the header keys and the `## ` sections of the body. */
export function parseState(text: string): { marks: Record<string, string>; sections: Record<string, string[]> } {
  const [head, body] = text.startsWith("---\n") ? [text.slice(4).split("\n---\n")[0] ?? "", text.slice(4).split("\n---\n").slice(1).join("\n---\n")] : ["", text];
  const marks = Object.fromEntries(head.split("\n").filter((line) => line.includes(":")).map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim().replace(/^"(.*)"$/, "$1")]));
  const sections: Record<string, string[]> = {};
  let name: string | null = null;
  for (const row of body.split("\n")) {
    const heading = STATE_HEADING.exec(row);
    if (heading) { name = heading[1]!; sections[name] = []; continue; }
    if (name && row.trim()) sections[name]!.push(row.trim());
  }
  return { marks, sections };
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
