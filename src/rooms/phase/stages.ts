import { createHash } from "node:crypto";
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
export function validationGaps(items: readonly PlanItem[]): string[] {
  return items.filter((item) => {
    const checks = Array.isArray(item.task.verification) ? (item.task.verification as Array<{ command?: unknown }>).map((check) => String(check.command ?? "")) : [];
    return checks.length > 0 && checks.every((command) => EXISTENCE_ONLY.test(command));
  }).map((item) => `${item.id}: every check only tests that a file exists — add one that would fail without the work (VALIDATION.md)`);
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
export const ANIMATOR_LAW = "motion rows: animate transform and opacity only, 150–300 ms for UI feedback, ease-out entering and ease-in leaving, respect prefers-reduced-motion, no motion that blocks input, every animation has its end state drawn";

/** UI contract gate and «design contract is mandatory»: a drawing carries its checkable points (UI-SPEC.md or DESIGN.md in its paths). */
export function uiContractGap(record: PhaseRecord): string | null {
  if (record.design?.decision !== "needed" || !record.design.drawing?.paths.length) return null;
  return record.design.drawing.paths.some((path) => /(UI-SPEC|DESIGN)\.md$/i.test(path)) ? null
    : "the drawing has no contract: add UI-SPEC.md with the checkable points (screens, states, breakpoints) to the drawing's paths";
}

/** The previous contract to the archive: a drawing replaced by a new one is kept, with its hash, in the record and the book. */
export function archiveDrawing(record: PhaseRecord, next: Drawing): Drawing[] {
  const prev = record.design?.drawing;
  return prev && prev.sha256 !== next.sha256 ? [...(record.design?.archived ?? []), prev].slice(-10) : record.design?.archived ?? [];
}

/** The wave table into the journal: one row per piece of the wave as it is issued. */
export function waveTable(wave: number, pieces: readonly PlanItem[], issued: Readonly<Record<string, string>>): string {
  return [`wave ${wave}:`, "| piece | task | promise |", "|---|---|---|", ...pieces.map((item) => `| ${item.id} | ${issued[item.id] ?? "—"} | ${item.promise.then.replace(/\|/g, "/")} |`)].join("\n");
}

/** UAT.md made from the plan's promises (SMA: Create UAT.md): one line per promise for the person to test and answer. */
export function uatText(phase: Pick<Phase, "id" | "title" | "goal" | "record">): string {
  const items = phase.record.plan?.items ?? [];
  return [`# UAT — phase ${phase.id}: ${phase.title}`, "", `Goal: ${phase.goal}`, "",
    "One line per test. Mark `[x]` passed, `[!]` failed (and say what you saw), `[ ]` open. The phase is accepted only when every line passed.", "",
    ...items.map((item) => `- [ ] ${item.id}: given ${item.promise.given}, when ${item.promise.when}, then ${item.promise.then}`), ""].join("\n");
}

const UAT_LINE = /^- \[([ xX!])\] (.+)$/;

/** Is a UAT session open, and is it complete: the lines of UAT.md by state. */
export function uatState(text: string): { lines: number; passed: number; failed: string[]; open: string[] } {
  const rows = text.split("\n").map((line) => line.trim().match(UAT_LINE)).filter((row): row is RegExpMatchArray => !!row);
  return { lines: rows.length, passed: rows.filter((row) => /[xX]/.test(row[1]!)).length, failed: rows.filter((row) => row[1] === "!").map((row) => row[2]!), open: rows.filter((row) => row[1] === " ").map((row) => row[2]!) };
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

/** Transition (SMA: advance to the next phase): the first open row of the roadmap. */
export function nextRoadmapRow(text: string): { n: string; name: string; goal: string } | null {
  for (const line of text.split("\n")) {
    const found = line.trim().match(ROW);
    if (found && found[1] === " ") return { n: found[2]!, name: found[3]!.trim(), goal: (found[4] ?? "").trim() };
  }
  return null;
}

/** Marks in STATE: the header keys phase and stage set, the body kept (lane-plan reads the same header). */
export function stateText(previous: string | null, marks: Record<string, string>): string {
  const today = new Date().toISOString().slice(0, 10);
  const [head, body] = previous?.startsWith("---\n") ? [previous.slice(4).split("\n---\n")[0] ?? "", previous.slice(4).split("\n---\n").slice(1).join("\n---\n")] : ["", previous ?? "\n# State\n"];
  const keys = new Map(head.split("\n").filter((line) => line.includes(":")).map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]));
  for (const [key, value] of Object.entries({ ...marks, updated: today })) keys.set(key, JSON.stringify(value));
  return `---\n${[...keys].map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

export const sha = (text: string) => createHash("sha256").update(text).digest("hex");
