import { inventory, renderThreadEvents, type ThreadEventLike, type Tree } from "@lane-pilot/harness-core";

/**
 * The evidence tree an editor reads (Harness² `core/context.py`), as files for one folder:
 *
 *   context/task.md                  what the area is and which attempts are here
 *   context/attempts/<id>/brief.md   the contract and the context the writer got (rules, memory, skills)
 *   context/attempts/<id>/trajectory.md   the writer thread, rendered
 *   context/attempts/<id>/outcome.md      state, reason, verification output, the critic's findings
 *   context/harness/<rel>            the tree being edited
 *   context/library/INDEX.md + <id>/      earlier adopted trees of the area with their EXPERIENCE.md
 *   context/pool/<label>/harness/, harness.diff, notes.md   candidates (compose and reflection only)
 *   context/decisions/<label>.md     the editors' notes
 *
 * Everything here is pure: rows in, `rel -> content` out. The service writes the files and runs the threads.
 */
export type AttemptEvidence = {
  attemptId: string; taskId: string; attemptNo: number; state: string; reason: string | null; createdAt: number;
  contract: Record<string, unknown>;
  dispatch: { rulesText?: string; memoryText?: string; promptChars?: number; skills?: string[]; harness?: { id?: string; arm?: string } } | null;
  events: ThreadEventLike[] | null;
  output: string | null;
  verification: Array<{ command?: string; exitCode?: number; stdout?: string; stderr?: string }>;
  critique: { decision?: string; summary?: string; findings?: Array<{ severity?: string; path?: string; line?: number; finding?: string; criterion?: string }> } | null;
};

export type LibraryEntry = { id: string; tree: Tree; experienceMd: string; createdAt: number; state: string };

export type PoolCandidate = { label: string; tree: Tree; diff: string; notes: string };

const clip = (text: string | null | undefined, n: number): string => {
  const s = (text ?? "").trim();
  return s.length <= n ? s : `${s.slice(0, n)}\n…[+${s.length - n} chars]`;
};

export function evidenceFiles(input: {
  area: string; writerKey: string; attempts: readonly AttemptEvidence[]; harness: Tree; library: readonly LibraryEntry[];
  pool?: readonly PoolCandidate[]; decisions?: Record<string, string>; baseHarness?: Tree;
}): Record<string, string> {
  const files: Record<string, string> = {};
  const areaName = input.area || "(whole project)";
  files["context/task.md"] = [
    `# Area «${areaName}», writers on ${input.writerKey === "*" ? "any model" : input.writerKey}`,
    "",
    `${input.attempts.length} recent attempts of this area are under context/attempts/, newest first. Each has the brief the writer got, its full trajectory and its outcome.`,
    "",
    "| attempt | task | try | outcome | blocking findings | prompt chars |",
    "|---|---|---|---|---|---|",
    ...input.attempts.map((a) => `| ${a.attemptId} | ${String(a.contract.title ?? a.taskId).replace(/\|/g, "/")} | ${a.attemptNo} | ${a.state}${a.reason ? `: ${clip(a.reason, 80).replace(/\n/g, " ")}` : ""} | ${(a.critique?.findings ?? []).filter((f) => f.severity === "blocking" || f.severity === "critical" || f.severity === "high").length} | ${a.dispatch?.promptChars ?? "?"} |`),
    "",
  ].join("\n");
  for (const a of input.attempts) {
    const dir = `context/attempts/${a.attemptId}`;
    files[`${dir}/brief.md`] = [
      `# ${a.taskId} (try ${a.attemptNo})`,
      "",
      "## Contract",
      "```json",
      JSON.stringify(a.contract, null, 2).slice(0, 12_000),
      "```",
      "",
      "## Rules the writer was given",
      a.dispatch?.rulesText?.trim() || "(none)",
      "",
      "## Memory the writer was given",
      a.dispatch?.memoryText?.trim() || "(none)",
      "",
      `## Skills: ${a.dispatch?.skills?.join(", ") || "(role skills only)"}`,
      a.dispatch?.harness?.id ? `## Harness tree: ${a.dispatch.harness.id} (arm ${a.dispatch.harness.arm ?? "-"})` : "## Harness tree: base (empty)",
      "",
    ].join("\n");
    files[`${dir}/trajectory.md`] = a.events ? renderThreadEvents(a.events) || "(the thread has no renderable events)" : "(the writer thread's events could not be read)";
    files[`${dir}/outcome.md`] = [
      `# Outcome: ${a.state}`,
      a.reason ? `Reason: ${clip(a.reason, 2000)}` : "",
      "",
      "## Writer's answer",
      clip(a.output, 4000) || "(none recorded)",
      "",
      "## Verification",
      ...(a.verification.length ? a.verification.map((v) => `### \`${v.command ?? "?"}\` → exit ${v.exitCode ?? "?"}\n\`\`\`\n${clip(`${v.stderr ?? ""}\n${v.stdout ?? ""}`, 3000)}\n\`\`\``) : ["(no checks ran)"]),
      "",
      "## Critic",
      a.critique ? `${a.critique.decision ?? ""}: ${clip(a.critique.summary, 1500)}` : "(no critique)",
      ...((a.critique?.findings ?? []).slice(0, 20).map((f) => `- [${f.severity ?? "?"}] ${f.path ?? ""}${f.line ? `:${f.line}` : ""} ${clip(f.finding ?? f.criterion ?? "", 300).replace(/\n/g, " ")}`)),
      "",
    ].join("\n");
  }
  for (const [rel, content] of Object.entries(input.harness)) files[`context/harness/${rel}`] = content;
  if (input.baseHarness) for (const [rel, content] of Object.entries(input.baseHarness)) files[`context/base_harness/${rel}`] = content;
  if (input.library.length) {
    files["context/library/INDEX.md"] = [
      `# Library — ${areaName}`,
      "",
      "Each entry is an earlier tree of this area that went through a trial, stored in full with the note on what each edit did. Browse this index, then open the entries that look relevant.",
      "",
      ...input.library.flatMap((entry) => [`## \`${entry.id}/\` (${entry.state})`, `- harness: \`${entry.id}/harness/\` — ${inventory(entry.tree)}`, `- why: \`${entry.id}/EXPERIENCE.md\``, ""]),
    ].join("\n");
    for (const entry of input.library) {
      files[`context/library/${entry.id}/EXPERIENCE.md`] = entry.experienceMd;
      for (const [rel, content] of Object.entries(entry.tree)) files[`context/library/${entry.id}/harness/${rel}`] = content;
    }
  }
  for (const candidate of input.pool ?? []) {
    files[`context/pool/${candidate.label}/harness.diff`] = candidate.diff || "(identical to the current harness)";
    files[`context/pool/${candidate.label}/notes.md`] = candidate.notes || "(no notes)";
    for (const [rel, content] of Object.entries(candidate.tree)) files[`context/pool/${candidate.label}/harness/${rel}`] = content;
  }
  for (const [label, notes] of Object.entries(input.decisions ?? {})) files[`context/decisions/${label}.md`] = notes || "No decision notes returned.";
  return files;
}

/** The layout line block the mission points at; only what exists is named. */
export function evidenceLayout(files: Record<string, string>): string {
  const has = (prefix: string) => Object.keys(files).some((rel) => rel.startsWith(prefix));
  const attempts = new Set(Object.keys(files).filter((rel) => rel.startsWith("context/attempts/")).map((rel) => rel.split("/")[2]));
  const lines = ["context/task.md                   the area and the list of attempts"];
  if (attempts.size) lines.push(`context/attempts/<id>/            ${attempts.size} attempts: brief.md, trajectory.md (full), outcome.md`);
  lines.push(`context/harness/                  the harness you are editing (${Object.keys(files).filter((rel) => rel.startsWith("context/harness/")).length} files; empty means the base)`);
  if (has("context/base_harness/")) lines.push("context/base_harness/             the tree before this round");
  if (has("context/pool/")) lines.push("context/pool/<label>/             candidates: harness/, harness.diff, notes.md");
  if (has("context/decisions/")) lines.push("context/decisions/<label>.md      the editors' notes");
  if (has("context/library/")) lines.push("context/library/                  earlier trees of this area; browse INDEX.md first");
  return lines.join("\n");
}

/** A unified-style diff of two trees, file by file, for the pool. */
export function treeDiff(before: Tree, after: Tree): string {
  const out: string[] = [];
  for (const rel of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[rel], b = after[rel];
    if (a === b) continue;
    out.push(`--- current/${rel}`, `+++ candidate/${rel}`);
    if (a !== undefined) for (const line of a.split("\n")) out.push(`-${line}`);
    if (b !== undefined) for (const line of b.split("\n")) out.push(`+${line}`);
    out.push("");
  }
  return out.join("\n");
}

/**
 * How an edited tree comes back from a host: one shell command prints every file under `context/harness/` as base64
 * between markers, and `parseHarvest` turns that into a tree. Base64 keeps any content safe in a text stream.
 */
export const harvestCommand = (dir = "context/harness"): string =>
  `cd ${shellQuote(dir)} 2>/dev/null || { echo '@@EMPTY'; exit 0; }; find . -type f ! -path '*/node_modules/*' ! -path '*/__pycache__/*' | LC_ALL=C sort | while IFS= read -r f; do echo "@@FILE $\{f#./}"; base64 < "$f"; echo '@@END'; done`;

export function parseHarvest(stdout: string): Tree {
  const tree: Tree = {};
  let current: string | null = null;
  let chunks: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@FILE ")) { current = line.slice(7).trim(); chunks = []; continue; }
    if (line === "@@END") {
      if (current) tree[current] = Buffer.from(chunks.join(""), "base64").toString("utf8");
      current = null;
      continue;
    }
    if (current !== null) chunks.push(line.trim());
  }
  return tree;
}

export const shellQuote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;

const requestText = (event: ThreadEventLike): string => {
  const data = (event.data && typeof event.data === "object" ? event.data : {}) as { input?: unknown; text?: unknown };
  const parts = Array.isArray(data.input) ? data.input as Array<{ text?: unknown }> : [];
  return [typeof data.text === "string" ? data.text : "", ...parts.map((part) => (typeof part?.text === "string" ? part.text : ""))].join("\n");
};

/**
 * Sticky writers take several tasks in one thread: the attempt's own turns start at the request that names its task
 * («Lane Pilot task <id>: …») and end before the request of the next task. Without such a request the whole thread is
 * returned, which is what a single-task thread is.
 */
export function sliceAttemptEvents(events: readonly ThreadEventLike[], taskId: string): ThreadEventLike[] {
  const ordered = [...events].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  const isRequest = (event: ThreadEventLike) => event.type === "client/turn/requested";
  // A task starts with the first brief («Lane Pilot task <id>: …») or a sticky writer's next-task turn, whose contract names the id.
  const startsTask = (text: string) => /Lane Pilot task [\w.-]+:/.test(text) || text.includes("Next task for you in the same area");
  const names = (text: string, id: string) => text.includes(`Lane Pilot task ${id}:`) || text.includes(`"id": "${id}"`) || text.includes(`"id":"${id}"`);
  const start = ordered.findIndex((event) => isRequest(event) && names(requestText(event), taskId));
  if (start < 0) return ordered;
  let end = ordered.length;
  for (let i = start + 1; i < ordered.length; i++) {
    const event = ordered[i]!;
    if (!isRequest(event)) continue;
    const text = requestText(event);
    if (startsTask(text) && !names(text, taskId)) { end = i; break; }
  }
  return ordered.slice(start, end);
}

/**
 * A shell command that writes `files` under `dir` (paths relative), creating folders; content travels as base64 in
 * pieces of at most `CHUNK_BYTES`, each its own argument: Linux caps one argument at 128 KB (MAX_ARG_STRLEN), and the
 * first SelfyStudio editors died on `spawn E2BIG` with whole trajectories in one printf (2026-10-19).
 */
export const CHUNK_BYTES = 48_000;

export function writeFilesCommand(dir: string, files: Record<string, string>): string {
  const lines = [`mkdir -p ${shellQuote(dir)} || exit 1`, `cd ${shellQuote(dir)} || exit 1`];
  for (const [rel, content] of Object.entries(files)) {
    const safe = rel.replace(/\\/g, "/");
    if (safe.startsWith("/") || safe.split("/").includes("..")) continue;
    const parent = safe.includes("/") ? safe.slice(0, safe.lastIndexOf("/")) : ".";
    const bytes = Buffer.from(content, "utf8");
    lines.push(`mkdir -p ${shellQuote(parent)} && : > ${shellQuote(safe)} || exit 1`);
    if (bytes.length === 0) continue;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      lines.push(`printf '%s' ${shellQuote(bytes.subarray(offset, offset + CHUNK_BYTES).toString("base64"))} | base64 -d >> ${shellQuote(safe)} || exit 1`);
    }
  }
  lines.push("echo @@WRITTEN");
  return lines.join("\n");
}

/** How many bytes of command one file costs, for the caller's batching. */
export const commandCost = (rel: string, content: string): number => Math.ceil(Buffer.byteLength(content, "utf8") * 1.37) + (Math.ceil(Buffer.byteLength(content, "utf8") / CHUNK_BYTES) + 1) * (rel.length + 60);
