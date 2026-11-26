const QUICK_TABLE = "## Quick Tasks Completed";

/** One line, no table break and no heading: whitespace collapsed, «|» replaced, leading «#» dropped. */
const tableCell = (text: string) => text.replace(/\s+/g, " ").replace(/\|/g, "/").trim().replace(/^#+\s*/, "");

/** Where a phase keeps its own files in the project: the book, and the drawing in design/ (SMA: The phase has a home, Drawing in its own folder). */
export const phaseFolder = (phaseId: string) => `.agents/phases/${phaseId}`;

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
 * and size go into the record (live ph_26f65b142d: «cannot read …/design/00-kit.png: lane_pilot_read_binary_rejected» failed lp.draw).
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
