import type { MemoryAudience, MemoryCandidate, MemoryKind, MemoryRecord } from "./settings";

/**
 * The lane-memory file record (claude-lane-stack `bin/lane_memory.py`, schema 2): YAML front matter
 * with a one-sentence claim and a Markdown body. Only the fields Lane Pilot needs are read; the file
 * is never rewritten in place.
 */
export type LaneMemoryFile = {
  id: string;
  status: string;
  claim: string;
  body: string;
  memoryType: string;
  sensitivity: string;
  contextPriority: string;
  areas: string[];
  hint: string;
  /** ISO date after which the record no longer holds; empty when it has none. */
  validUntil: string;
};

const SENSITIVITY_TO_AUDIENCE: Record<string, MemoryAudience> = { public: "export", internal: "subagent", sensitive: "owner", "encrypted-required": "owner" };
const AUDIENCE_TO_SENSITIVITY: Record<MemoryAudience, string> = { export: "public", subagent: "internal", owner: "sensitive" };

export function audienceForSensitivity(sensitivity: string | undefined): MemoryAudience {
  return SENSITIVITY_TO_AUDIENCE[sensitivity ?? "internal"] ?? "subagent";
}

export function sensitivityForAudience(audience: MemoryAudience): string {
  return AUDIENCE_TO_SENSITIVITY[audience];
}

function unquote(value: string): string {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

function listValue(value: string): string[] {
  const text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) return text.slice(1, -1).split(",").map((item) => unquote(item)).filter(Boolean);
  return text ? [unquote(text)] : [];
}

/** Reads the front matter keys Lane Pilot uses; nested `retrieval:` gives areas and hint. Returns null without front matter or an id. */
export function parseLaneMemoryFile(text: string): LaneMemoryFile | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const front = text.slice(4, end).split("\n");
  const body = text.slice(end + 4).replace(/^\n+/, "").trimEnd();
  const top: Record<string, string> = {};
  const retrieval: Record<string, string> = {};
  let section: string | null = null;
  let pendingList: string | null = null;
  const lists: Record<string, string[]> = {};
  for (const line of front) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      pendingList = null;
      const match = line.match(/^([A-Za-z_]\w*):\s*(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (value === "") { section = key!; continue; }
      section = null;
      top[key!] = unquote(value!);
    } else if (section === "retrieval") {
      const match = line.trim().match(/^([A-Za-z_]\w*):\s*(.*)$/);
      if (match) {
        if (match[2] === "") { pendingList = match[1]!; lists[pendingList] = []; }
        else retrieval[match[1]!] = match[2]!;
      } else if (pendingList && line.trim().startsWith("- ")) {
        lists[pendingList]!.push(unquote(line.trim().slice(2)));
      }
    }
  }
  const id = top.id?.trim();
  if (!id) return null;
  return {
    id,
    status: top.status ?? "active",
    claim: top.claim ?? "",
    body,
    memoryType: top.memory_type ?? "normative",
    sensitivity: top.sensitivity ?? "internal",
    contextPriority: top.context_priority ?? "normal",
    areas: lists.areas ?? (retrieval.areas ? listValue(retrieval.areas) : []),
    hint: retrieval.hint ? unquote(retrieval.hint) : "",
    validUntil: top.valid_until?.trim() ?? "",
  };
}

const CONTENT_MAX = 4000;

/** A file record as a memory candidate: `always` files are core, the claim leads, the body follows within bounds. */
export function laneMemoryFileToCandidate(file: LaneMemoryFile, now = new Date()): { candidate: MemoryCandidate; audience: MemoryAudience } | null {
  if (file.status !== "active") return null;
  if (file.validUntil && !Number.isNaN(Date.parse(file.validUntil)) && Date.parse(file.validUntil) < now.getTime()) return null;
  const content = [file.claim.trim(), file.body.trim()].filter(Boolean).join("\n\n").slice(0, CONTENT_MAX);
  if (!content) return null;
  const hintTerms = file.hint.split(/[,;]/).map((term) => term.trim().toLowerCase()).filter(Boolean);
  const concepts = [...new Set([file.id.toLowerCase(), ...file.areas.map((area) => area.toLowerCase()), ...hintTerms])].slice(0, 24);
  const kind: MemoryKind = file.contextPriority === "always" ? "core" : "note";
  const until = file.validUntil ? Date.parse(file.validUntil) : NaN;
  return { candidate: { kind, content, concepts, sourceFileId: file.id, ...(Number.isNaN(until) ? {} : { validUntil: until }) }, audience: audienceForSensitivity(file.sensitivity) };
}

/** The file name Lane Pilot uses for a record it exports; stable per record, never colliding with hand-written ids. */
export function exportedFileName(record: Pick<MemoryRecord, "id">): string {
  return `lp-${record.id.slice(0, 16)}.md`;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

/** Renders a record as a lane-memory file (schema 2, every required field), so the CLI hooks index it like any other. */
export function renderLaneMemoryFile(record: MemoryRecord, audience: MemoryAudience, exportedAt = new Date()): string {
  const firstLine = record.content.split("\n").find((line) => line.trim()) ?? record.content;
  const claim = firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
  const body = record.content === firstLine ? "" : record.content.slice(record.content.indexOf(firstLine) + firstLine.length).trim();
  const date = exportedAt.toISOString().slice(0, 10);
  const areas = record.concepts.slice(0, 5);
  const language = /[Ѐ-ӿ]/.test(record.content) ? "ru" : "en";
  return [
    "---",
    `id: lp-${record.id.slice(0, 16)}`,
    "schema_version: 2",
    "status: active",
    `memory_type: ${record.kind === "core" ? "normative" : "semantic"}`,
    // A rule is a norm; a maintainer note is what an accepted task showed. Neither is an owner statement unless the owner confirmed it.
    `truth_mode: ${record.concepts.includes("rule") ? "normative" : "observed"}`,
    `claim: ${yamlString(claim)}`,
    `language: ${language}`,
    "source:",
    `  authority: ${record.concepts.includes("owner-confirmed") ? "owner-instruction" : "agent"}`,
    "evidence:",
    "  - type: lane-pilot",
    `    ref: ${yamlString(`memory ${record.id} ${date}`)}`,
    "risk: low",
    `sensitivity: ${sensitivityForAudience(audience)}`,
    `context_priority: ${record.kind === "core" ? "always" : "normal"}`,
    "retrieval:",
    `  areas: [${areas.map(yamlString).join(", ")}]`,
    `  hint: ${yamlString(record.concepts.join(", "))}`,
    "---",
    "",
    body || claim,
    "",
  ].join("\n");
}
