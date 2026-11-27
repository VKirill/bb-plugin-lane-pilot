import type { Field } from "@lane-pilot/workflow-engine";
import { isWholeConsent } from "../../tasks";
import { GENERIC_PROJECT_WORKFLOW_IDS, INTAKE_KINDS, SERVICE_KINDS, isMachineMessage, type IntakeKind, type ServiceKind } from "../../contracts";

export { GENERIC_PROJECT_WORKFLOW_IDS, INTAKE_KINDS, SERVICE_KINDS, isMachineMessage, type IntakeKind, type ServiceKind };

/** Above this many characters a message the rules cannot place is taken as heavy: a goal, not a fix. */
export const HEAVY_LENGTH = 700;

/**
 * A one-line request the LP database alone can answer: the status, what runs now, the latest results, a cancel. Short lines only:
 * a long message that mentions «status» is a task.
 */
const SERVICE_RULES: Array<[ServiceKind, RegExp]> = [
  ["cancel", /^(?:отмени|останови|cancel|stop)\s+(?:задач[а-яё]*|task)\s+\S+[\s.!]*$/i],
  ["current", /^(?:что (?:сейчас )?(?:идёт|идет|выполняется|в работе)|what(?:'s| is) (?:running|in progress)(?: now)?)[\s?.!]*$/i],
  ["results", /^(?:покажи (?:последние )?результаты|что (?:уже )?(?:готово|сделано)|show (?:the )?(?:latest |last )?results)[\s?.!]*$/i],
  ["status", /^(?:статус|status|как дела|как успехи|how(?:'s| is) it going)[\s?.!]*$/i],
];
export function serviceByRules(text: string): ServiceKind | null {
  const clean = text.trim();
  if (clean.includes("\n") || clean.length > 80) return null;
  return SERVICE_RULES.find(([, pattern]) => pattern.test(clean))?.[0] ?? null;
}

/** What the code settles alone; `confident: false` means the length rule only guessed and no machine start follows. */
export function intakeByRules(text: string): { kind: IntakeKind; confident: boolean; service?: ServiceKind } {
  const clean = text.trim();
  if (isWholeConsent(clean)) return { kind: "consent", confident: true };
  const service = serviceByRules(clean);
  if (service) return { kind: "service", confident: true, service };
  // One line that ends with «?» is a question at any length (ph_82dfc9db78, 2026-10-31: «Есть предложения как улучшить дизайн… на
  // телефонах?», 135 characters, went to the judgment, was read as heavy); a short request is small.
  if (!clean.includes("\n") && clean.endsWith("?")) return { kind: "question", confident: true };
  if (clean.length <= 80 && !clean.includes("\n")) return { kind: "small", confident: false };
  return { kind: clean.length > HEAVY_LENGTH ? "heavy" : "small", confident: false };
}

/** The one goal a user intake run is for: the owner's request, guessed from the message. A user workflow will not close verified without it. */
export function intakeRunGoals(text: string): Array<{ id: "request"; done_when: string; evidence: string; guess: true }> {
  const title = text.trim().split("\n").find((line) => line.trim())?.trim().slice(0, 120) || "Owner's request";
  return [{ id: "request", done_when: `The owner's request is done: ${title}`.slice(0, 600), evidence: "the workflow output status is closed and its comment says what changed", guess: true }];
}

/** A title from the owner's words: the first line, at most 80 characters. */
export function intakeTitle(text: string): string {
  const first = text.trim().split("\n").find((line) => line.trim())?.trim() ?? "Цель владельца";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** What the dispatch tool tells a PM the first time it hands out the work of a request that is a new process (SMA: processes become small graphs). */
export function processHint(): string {
  return "This request of the owner is a new process: a routine the system should run again and again. In Matvey's system a new process becomes a small graph, not one-off code: " +
    "suggest the Workflow architect, or draft it yourself with lane_pilot_workflow_draft (action get, patch, test); publishing waits for the owner's yes; then run it with lane_pilot_route. " +
    "If the request is in fact one-off work, dispatch it again: this hint is given once per request.";
}

/** The PM's note when the owner's process is a graph the catalog already has: run that one, no new graph is built. */
export function publishedHint(found: { graphId: string; name: string; confidence: number }): string {
  return `[Lane Pilot intake] The owner's request matches the published graph ${found.graphId} («${found.name}», router confidence ${found.confidence}). No workflow architect was started for it. If it fits, start it (lane_pilot_route with the owner's words, then lane_pilot_run_workflow {workflowId: \"${found.graphId}\"}); if it does not, say why and build a new one (lane_pilot_forge).`;
}

/** Builds a single owner-ask form payload listing every missing required template input at once. */
export function missingTemplateInputsQuestion(input: {
  workflowId: string;
  workflowName: { en: string; ru: string };
  missing: readonly Field[];
  ru: boolean;
}): { question: string; detail: string } {
  const names = input.missing.map((field) => field.name);
  const title = input.ru ? (input.workflowName.ru || input.workflowName.en) : (input.workflowName.en || input.workflowName.ru);
  const question = input.ru
    ? `Для шаблона «${title}» (${input.workflowId}) нужны входные данные: ${names.join(", ")}.`
    : `Template "${title}" (${input.workflowId}) needs required inputs: ${names.join(", ")}.`;
  const lines = input.missing.map((field) => {
    const typeHint = field.type === "enum" && field.values?.length ? field.values.join(" | ") : field.type;
    const note = field.description ?? field.note;
    return `- ${field.name} (${typeHint})${note ? ` — ${note}` : ""}`;
  });
  const hint = input.ru
    ? "Ответьте значениями (если полей несколько — каждое с новой строки в виде `имя: значение`)."
    : "Reply with the values (for multiple fields, one per line as `name: value`).";
  return { question, detail: `${lines.join("\n")}\n\n${hint}` };
}

function coerceFieldValue(field: Field, raw: string): unknown {
  const val = raw.trim();
  if (!val) return undefined;
  switch (field.type) {
    case "number": {
      const n = Number(val);
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean": {
      if (/^(true|yes|да|1|on)$/i.test(val)) return true;
      if (/^(false|no|нет|0|off)$/i.test(val)) return false;
      return undefined;
    }
    case "enum": {
      const values = field.values ?? [];
      return values.find((v) => v === val || v.toLowerCase() === val.toLowerCase());
    }
    case "array": {
      if (val.startsWith("[")) {
        try {
          const parsed = JSON.parse(val) as unknown;
          if (Array.isArray(parsed)) return parsed;
        } catch { /* fall back to delimited items */ }
      }
      return val.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    }
    case "object": {
      if (val.startsWith("{")) {
        try {
          const parsed = JSON.parse(val) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch { /* ignore invalid JSON object */ }
      }
      return undefined;
    }
    default:
      return val;
  }
}

/** Extracts missing template input values from the owner's single reply (`name: value` pairs, URL/file signals, or positional lines). */
export function parseMissingInputsAnswer(missing: readonly Field[], text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const trimmed = text.trim();
  if (!trimmed || missing.length === 0) return out;

  const byName = new Map(missing.map((f) => [f.name.toLowerCase(), f]));
  const unmatchedLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]{0,47})\s*[:=]\s*(.+)$/.exec(clean);
    const field = kv ? byName.get(kv[1]!.toLowerCase()) : undefined;
    if (field && kv) {
      const coerced = coerceFieldValue(field, kv[2]!);
      if (coerced !== undefined) {
        out[field.name] = coerced;
        continue;
      }
    }
    unmatchedLines.push(clean);
  }

  const urls = [...trimmed.matchAll(/https?:\/\/[^\s)>"']+/g)].map((m) => m[0]);
  for (const field of missing) {
    if (out[field.name] !== undefined) continue;
    if (/^(url|source|site_url|health_url|google_card_url|card_url)$/.test(field.name) && urls[0] && field.type === "string") {
      out[field.name] = urls[0];
    } else if (field.name === "post_urls" && urls.length && field.type === "array") {
      out[field.name] = urls;
    }
  }

  const remaining = missing.filter((f) => out[f.name] === undefined);
  if (remaining.length === 1) {
    const coerced = coerceFieldValue(remaining[0]!, unmatchedLines.length === 1 ? unmatchedLines[0]! : trimmed);
    if (coerced !== undefined) out[remaining[0]!.name] = coerced;
  } else if (remaining.length > 1 && unmatchedLines.length > 0) {
    for (let i = 0; i < remaining.length && i < unmatchedLines.length; i += 1) {
      const coerced = coerceFieldValue(remaining[i]!, unmatchedLines[i]!);
      if (coerced !== undefined) out[remaining[i]!.name] = coerced;
    }
  }
  return out;
}
