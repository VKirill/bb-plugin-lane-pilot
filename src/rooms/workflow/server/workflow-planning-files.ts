import { sha256Hex } from "@lane-pilot/kit";
import { str } from "./workflow-chain-runtime";
import { quickRow } from "../../phase";

export const QUICK_STATE_PATH = ".agents/planning/STATE.md";

/** The STATE.md write of a finished quick task: null when the project has no STATE.md (exit code of the read), else the new text and the hash it replaces. */
export function quickStateEdit(read: { exitCode: number; stdout: string }, row: { date: string; task: string; commit: string }): { content: string; expectedSha256: string } | null {
  const content = read.exitCode === 0 ? quickRow(read.stdout, row) : null;
  return content === null ? null : { content, expectedSha256: sha256Hex(read.stdout) };
}

/** The file name of a debug session: letters, digits, dot, dash and underscore only, so it can never leave .agents/planning/debug/ ("" when nothing is left). */
export function debugSessionSlug(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+|[.-]+$/g, "").slice(0, 60);
}

/** A new session file: the symptom (a list from the phase is one gap per line) and the empty sections. */
export function debugSessionDoc(slug: string, symptom: unknown): string {
  const text = (Array.isArray(symptom) ? symptom.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n") : str(symptom)).slice(0, 2000);
  return `# Debug session — ${slug}\n\nStatus: open\n\n## Symptom\n\n${text || "—"}\n\n## Hypotheses\n\n## Evidence\n\n## Root cause\n\n## Fix directions\n`;
}
