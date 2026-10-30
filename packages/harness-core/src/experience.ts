/**
 * What an editor, a composer and a reflection reply with, parsed. The replies are text for a person first; these
 * parsers take the one machine-readable part of each and refuse to invent what is missing.
 *
 *   <notes> … </notes>            the editor's and the composer's: one line per decision; KEEP_BASE means no change
 *   <edits> … </edits>            the reflection's table: one five-line row per changed component, with a verdict
 *   <experience> … </experience>  the reflection's single transferable lesson, or the line NO_ENTRY in its place
 */
export const EDIT_VERDICTS = ["helped", "hurt", "no observed effect", "confounded"] as const;
export type EditVerdict = (typeof EDIT_VERDICTS)[number];

export type EditRow = { component: string; candidates: string; change: string; observed: string; verdict: EditVerdict };

export type Experience = { cue: string; lesson: string; evidence: string; confidence: "high" | "medium" | "low" | ""; edits?: string };

export const KEEP_BASE = "KEEP_BASE";
export const NO_ENTRY = "NO_ENTRY";

const block = (text: string, tag: string): string | null => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim() ?? null;

export function parseNotes(text: string): { notes: string; keepBase: boolean } {
  const notes = block(text, "notes") ?? text.trim();
  return { notes, keepBase: new RegExp(`\\b${KEEP_BASE}\\b`).test(notes) };
}

/** The reflection's edit rows. A row missing its verdict, or with one outside the four, is dropped, not guessed. */
export function parseEdits(text: string): EditRow[] {
  const body = block(text, "edits");
  if (!body) return [];
  const rows: EditRow[] = [];
  let current: Partial<EditRow> = {};
  const flush = (): void => {
    if (current.component && current.verdict && (EDIT_VERDICTS as readonly string[]).includes(current.verdict)) {
      rows.push({ component: current.component, candidates: current.candidates ?? "", change: current.change ?? "", observed: current.observed ?? "", verdict: current.verdict });
    }
    current = {};
  };
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const m = /^(component|candidates|change|observed|verdict)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase() as keyof EditRow;
    if (key === "component" && current.component) flush();
    const value = m[2]!.trim();
    if (key === "verdict") current.verdict = value.toLowerCase().replace(/\.$/, "") as EditVerdict;
    else current[key] = value;
  }
  flush();
  return rows;
}

/**
 * The single transferable lesson, or null: NO_ENTRY, a missing block, or a block without cue, lesson and evidence all
 * mean the record supports no entry. Adoption alone never makes one.
 */
export function parseExperience(text: string): Experience | null {
  const body = block(text, "experience");
  if (!body || new RegExp(`^\\s*${NO_ENTRY}\\b`, "m").test(text) && !body) return null;
  if (new RegExp(`\\b${NO_ENTRY}\\b`).test(body)) return null;
  const out: Record<string, string> = {};
  for (const raw of body.split("\n")) {
    const m = /^\s*(cue|lesson|evidence|confidence)\s*:\s*(.*)$/i.exec(raw);
    if (m) out[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  if (!out.cue || !out.lesson || !out.evidence) return null;
  const level = /^(high|medium|low)\b/i.exec(out.confidence ?? "")?.[1]?.toLowerCase() as Experience["confidence"] | undefined;
  const edits = block(text, "edits");
  return { cue: out.cue, lesson: out.lesson, evidence: out.evidence, confidence: level ?? "", ...(edits ? { edits } : {}) };
}

/** Components a trial kept but never saw change an outcome. The next editor is told to remove them. */
export function deletionCandidates(rows: readonly EditRow[]): string[] {
  return rows.filter((row) => row.verdict === "no observed effect").map((row) => row.component);
}

/** A lesson resting only on confounded rows is a guess: the reflection was told to narrow it or decline. */
export function experienceIsSupported(experience: Experience | null, rows: readonly EditRow[]): boolean {
  if (!experience) return false;
  if (rows.length === 0) return true;
  return rows.some((row) => row.verdict === "helped" || row.verdict === "hurt");
}

/** EXPERIENCE.md as the library stores it: why the tree was adopted, what each edit did, the one lesson. */
export function renderExperienceMarkdown(input: { title: string; adopted: string; inventory: string; why?: string; rows: readonly EditRow[]; experience: Experience | null }): string {
  const lines = [`# ${input.title}`, "", `- adopted: \`${input.adopted}\``, `- components: ${input.inventory}`, ""];
  if (input.why?.trim()) lines.push("## Why this was chosen", input.why.trim(), "");
  if (input.rows.length) {
    lines.push("## What each edit did", "", "| component | candidates | change | observed | verdict |", "|---|---|---|---|---|");
    for (const row of input.rows) lines.push(`| ${cell(row.component)} | ${cell(row.candidates)} | ${cell(row.change)} | ${cell(row.observed)} | ${row.verdict} |`);
    lines.push("");
    const drop = deletionCandidates(input.rows);
    if (drop.length) {
      lines.push("## Deletion candidates", "", "These components had no observed effect. The next editor removes them unless a trajectory shows they now matter.", "");
      for (const name of drop) lines.push(`- \`${name}\``);
      lines.push("");
    }
  }
  if (input.experience) {
    lines.push("## Transferable lesson");
    for (const key of ["cue", "lesson", "evidence", "confidence"] as const) if (input.experience[key]) lines.push(`- **${key}**: ${input.experience[key]}`);
    lines.push("");
  } else lines.push("## Transferable lesson", "", "_NO_ENTRY: the record showed no reusable execution contrast._", "");
  return lines.join("\n");
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
