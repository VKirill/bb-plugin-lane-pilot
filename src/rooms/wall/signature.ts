import { sha256Hex } from "@lane-pilot/kit";
import { failureClass, failureFingerprint } from "../runs";


/**
 * The signature of a failure: its failure class and its reason with the ids, hashes, numbers and paths taken out. The Lane Pilot version
 * and the project are not in it: they are the journal's dimensions, so one class can be followed across releases.
 */
const RETRY_WRAPPER = /^retry limit \d+ exhausted:\s*/i;
/** The failure codes that name a red check (an attempt's own `failure_code`). */
const RED_CHECK_CODES: ReadonlySet<string> = new Set(["verification_failed", "verification_timeout"]);
/** Several paths in a row («owns_paths rejected a, b, c») are one: the count of stray files is not a different problem. */
const PATH_LIST = /(?:[\w.@-]*<path>)(?:[,;]\s*[\w.@-]*<path>)*/g;

/**
 * What kind of file a rejected path is. Writers' stray test files, a shared locale file in parallel tasks and a lockfile are different problems
 * with different fixes (the 2026-10-19 night audit told them apart by hand), so the kinds are part of the class: `<paths:test>`, `<paths:locale>`.
 */
const PATHISH = /[\w.@[\]-]+(?:\/[\w.@[\]-]+)+|[\w.@-]+\.(?:json|ts|tsx|js|vue|md|css|lock|ya?ml|mjs|cjs)\b/g;
const OWNERSHIP = /owns_paths|outside owns_paths|never_touch/i;
export function pathKind(path: string): "test" | "locale" | "lockfile" | "src" {
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(path)) return "lockfile";
  if (/(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[a-z]+$/i.test(path)) return "test";
  if (/(^|[/.])(locales?|i18n|lang|translations?|messages)([/.]|$)/i.test(path)) return "locale";
  return "src";
}

export function normaliseReason(reason: string | null | undefined, failureCode?: string | null): string {
  const text = (reason ?? "").replace(RETRY_WRAPPER, "").trim();
  // A red check keeps only that it was a check: its command and output are the task's, and 13 red checks are one class,
  // not 13. The structured code answers it; a log line and a graph run carry none and keep their text.
  const redCheck = RED_CHECK_CODES.has(failureCode ?? "");
  let base = redCheck ? `verification failed (<check>)` : text;
  if (!redCheck && OWNERSHIP.test(text)) {
    // The list of rejected files after the keyword becomes one token that names the kinds of files in it.
    const start = text.search(OWNERSHIP);
    const kinds = new Set<string>();
    const marked = text.slice(start).replace(PATHISH, (path) => { kinds.add(pathKind(path)); return "\u0001"; });
    if (kinds.size) base = text.slice(0, start) + marked.replace(/\u0001(?:\s*[,;]\s*\u0001)*/g, `<paths:${[...kinds].sort().join("+")}>`);
  }
  return failureFingerprint(base, 200).replace(PATH_LIST, "<paths>").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Whose side a plugin log line is: a disconnected machine or a full disk is infra, anything else Lane Pilot's own. */
export const logOrigin = (message: string): "infra" | "harness" => (/Host is not connected|host offline|ENOSPC|no space left|disk_low|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(message) ? "infra" : "harness");

export type Signature = { failureClass: string; reasonNorm: string; classKey: string };

export function wallSignature(state: string, reason: string | null | undefined, failureCode?: string | null): Signature {
  const cls = failureClass(state, (reason ?? "").replace(RETRY_WRAPPER, ""));
  const reasonNorm = normaliseReason(reason, failureCode);
  return { failureClass: cls, reasonNorm, classKey: `${cls}:${sha256Hex(`${cls}|${reasonNorm}`).slice(0, 12)}` };
}

/** A plugin log line is its own class: Lane Pilot's failure line, with its ids, numbers and paths blanked. */
export function logSignature(message: string): Signature {
  const reasonNorm = normaliseReason(message);
  return { failureClass: "log", reasonNorm, classKey: `log:${sha256Hex(`log|${reasonNorm}`).slice(0, 12)}` };
}

/**
 * A graph run that ended badly is its own class: the workflow and what stopped it, from the reason's prefix (`step_failed:<node>`, `output_invalid`,
 * `budget_exceeded:cost`...). The words after the prefix are the run's own message and vary; the prefix is what repeats.
 */
export function wfSignature(workflowId: string, status: string, reason: string | null | undefined): Signature {
  const head = (reason ?? "").trim().split(/[\s(]/)[0]!.replace(/[0-9a-f]{12,}/gi, "<id>").slice(0, 80) || status;
  const reasonNorm = `${workflowId} ${status}: ${head}`;
  return { failureClass: "workflow", reasonNorm, classKey: `workflow:${sha256Hex(`workflow|${reasonNorm}`).slice(0, 12)}` };
}

/**
 * Whose fault, from the triage when it has an answer and from the failure class otherwise:
 * `orchestrator` (triage), `harness` and `infra` (the class), else the writer's / the task's / the environment's.
 */
export function originOf(cls: string, triageOrigin: string | null | undefined): string {
  if (triageOrigin === "orchestrator") return "orchestrator";
  if (cls === "harness" || cls === "log" || cls === "workflow") return "harness";
  if (cls === "infra") return "infra";
  if (triageOrigin === "environment") return "infra";
  if (triageOrigin) return triageOrigin;
  if (cls === "merge" || cls === "dirty_base" || cls === "limit" || cls === "budget") return "flow";
  return "task";
}

/**
 * The class a failed attempt belongs to, with its origin: within the «task» class, attempts on Lane Pilot's side (orchestrator,
 * harness, infra) are a class of their own. Before, one such attempt among 46 red checks of writers made the whole class Lane Pilot's,
 * the night repaired it every night, and its recurrence could not fall — most of it was writers' own red checks (night 2026-10-25,
 * task:3a88e7517c7a; the engineer named it). The writers' side keeps the old key, so its history stays.
 */
export function classKeyOf(sig: Signature, origin: string): string {
  return sig.failureClass === "task" && LANE_SIDE.includes(origin) ? `task:${sha256Hex(`task|${sig.reasonNorm}|lane`).slice(0, 12)}` : sig.classKey;
}
const LANE_SIDE: readonly string[] = ["orchestrator", "harness", "infra"];

/** The key of a night repair in the self-repair watcher's state, in its `kind:hash:text` shape: `night:<hash of the class>:<class and reason>`. */
export const repairSignature = (cls: { classKey: string; failureClass: string; reasonNorm: string }): string =>
  `night:${sha256Hex(cls.classKey).slice(0, 12)}:${cls.failureClass}: ${cls.reasonNorm}`.slice(0, 200);
