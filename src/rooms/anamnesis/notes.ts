import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { NotesResponse } from "./ops";
import { anamnesisDir, type Store } from "./store";
import type { AnamnesisRecord, Kind, Sensitivity } from "./model";
import { displayText } from "./whoami";

/**
 * The portrait of the owner as Markdown files, the source of truth (host side, next to the store). The folder is
 * `~/Notes/Обо мне/` on the Mac mini, mode 0700, the files 0600: they hold the owner's own notes, family and health included.
 *
 *   Обо мне.md, Знания.md, Умения.md, Семья и близкие.md, Хобби.md, Интересы.md, Хронология.md, Предпочтения.md  (confirmed)
 *   На проверку.md                                                                                              (new, not confirmed)
 *
 * Each fact is one bullet: readable prose, a small trailing note with the dates and a pointer to the evidence (`@thread:thr_…` or a
 * source and a date), and a hidden marker `<!-- a:<id> -->` that maps the line back to its record. A sync pass has two halves, the
 * first one reading, so that an owner's edit is never overwritten:
 *   1. the files that changed since our last write are read back: a line the owner changed becomes an edit of its record (confirmed),
 *      a line that is new becomes a confirmed record of that file's kind, a line that is gone becomes a rejection, a ticked checkbox in
 *      «На проверку» (or a line moved into a section file) a confirmation;
 *   2. the files are written again from the records, merged line by line into what is there: the owner's headings and prose stay, a
 *      line is replaced in its place, a new fact is added after the last bullet.
 */
export const notesDir = (): string =>
  process.env.LANE_PILOT_ANAMNESIS_NOTES_DIR || (process.env.LANE_PILOT_ANAMNESIS_DIR ? join(anamnesisDir(), "notes") : join(homedir(), "Notes", "Обо мне"));

type NoteFile = { name: string; title: string; kinds: readonly Kind[]; addKind: Kind; intro: string; sensitive?: boolean };
const HOW = "Файл — источник правды: правьте строки как угодно. Изменённая строка станет правкой записи, новая строка — подтверждённым фактом, удалённая — отклонённым. Скрытые метки в конце строк (комментарии) не трогайте.";
export const NOTE_FILES: readonly NoteFile[] = [
  { name: "Обо мне.md", title: "Обо мне", kinds: ["self", "fact"], addKind: "self", intro: "Кто я: характер, ценности, как я работаю и думаю." },
  { name: "Знания.md", title: "Знания", kinds: ["knowledge"], addKind: "knowledge", intro: "Что я знаю." },
  { name: "Умения.md", title: "Умения", kinds: ["skill"], addKind: "skill", intro: "Что я умею и на каком уровне." },
  { name: "Семья и близкие.md", title: "Семья и близкие", kinds: ["person"], addKind: "person", intro: "Мои близкие и кем они мне приходятся.", sensitive: true },
  { name: "Хобби.md", title: "Хобби", kinds: ["hobby"], addKind: "hobby", intro: "Чем я занимаюсь для души." },
  { name: "Интересы.md", title: "Интересы", kinds: ["interest"], addKind: "interest", intro: "Что мне интересно." },
  { name: "Хронология.md", title: "Хронология", kinds: ["event"], addKind: "event", intro: "События моей жизни по датам." },
  { name: "Предпочтения.md", title: "Предпочтения", kinds: ["preference"], addKind: "preference", intro: "Как я люблю, чтобы всё было сделано." },
];
export const REVIEW_FILE: NoteFile = { name: "На проверку.md", title: "На проверку", kinds: [], addKind: "fact",
  intro: "Новые находки, которых вы ещё не подтверждали. Поставьте [x], чтобы подтвердить; поправьте текст, чтобы исправить и подтвердить; удалите строку, чтобы отклонить." };
const ALL_FILES: readonly NoteFile[] = [...NOTE_FILES, REVIEW_FILE];

const KIND_RU: Record<Kind, string> = { self: "обо мне", fact: "факт", knowledge: "знание", skill: "умение", person: "близкие", hobby: "хобби", interest: "интерес", event: "событие", preference: "предпочтение", project: "проект", tool: "инструмент" };
const SOURCE_RU: Record<string, string> = { "bb-message": "чат", git: "git", journal: "журнал", registry: "реестр", "claude-memory": "память Claude", "bb-memory": "память BB", "lp-runs": "прогоны", telegram: "Telegram", elba: "Эльба", manual: "вручную" };

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const MARKER = /<!--\s*a:(\S+?)\s*-->/;
const BULLET = /^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(.*)$/;
const NOTE_TAIL = /\s+_\([^()]*\)_\s*$/;
const clean = (text: string): string => text.replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim();

type ParsedLine = { id: string | null; checked: boolean; body: string };
/** A bullet of a notes file: the text without its note and marker, the record id from the marker, whether the checkbox is ticked. Null for any other line. */
export function parseBullet(line: string): ParsedLine | null {
  const match = BULLET.exec(line);
  if (!match) return null;
  const marker = MARKER.exec(match[2]!);
  const raw = match[2]!.replace(/<!--\s*a:\S+?\s*-->/, "").trim();
  return { id: marker ? marker[1]! : null, checked: match[1] === "x" || match[1] === "X", body: raw.replace(NOTE_TAIL, "").trim() };
}

const month = (at: number): string => new Date(at).toISOString().slice(0, 7);
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
function range(first: number | null, last: number | null): string {
  const a = first ?? last, b = last ?? first;
  if (!a || !b) return "";
  if (dayOf(a) === dayOf(b)) return dayOf(a);
  return month(a) === month(b) ? month(a) : `${month(a)} — ${month(b)}`;
}

export type Heads = Map<string, { latest: { source: string; at: number }; thread?: string }>;

function renderLine(record: AnamnesisRecord, heads: Heads, review: boolean): string {
  const head = heads.get(record.id);
  const pointer = head?.thread ? `@thread:${head.thread}` : head ? `${SOURCE_RU[head.latest.source] ?? head.latest.source} ${dayOf(head.latest.at)}` : "";
  const level = record.kind === "skill" && record.attributes.origin === "git" && record.attributes.commits ? `коммитов: ${record.attributes.commits}` : "";
  const contradicts = Array.isArray(record.attributes.contradicts) && record.attributes.contradicts.length ? "противоречит другой записи" : "";
  const note = [review ? KIND_RU[record.kind] : "", range(record.firstSeen, record.lastSeen), level, contradicts, pointer].filter(Boolean).join(" · ");
  const text = clean(displayText(record, "ru")) || clean(record.title);
  return `- ${review ? "[ ] " : ""}${text}${note ? ` _(${note})_` : ""} <!-- a:${record.id} -->`;
}

function frontMatter(now: number, file: NoteFile): string[] {
  return ["---", `updated: ${new Date(now).toISOString()}`, `section: ${file.title}`, "source: lane-pilot-anamnesis", "---"];
}

const weightOf = (r: AnamnesisRecord): number => Number(r.attributes.commits ?? 0) + r.evidenceCount;
function order(file: NoteFile, records: AnamnesisRecord[]): AnamnesisRecord[] {
  const sorted = [...records];
  if (file.name === "Хронология.md") return sorted.sort((a, b) => (a.firstSeen ?? 0) - (b.firstSeen ?? 0));
  if (file.name === "Умения.md") return sorted.sort((a, b) => weightOf(b) - weightOf(a));
  return sorted.sort((a, b) => b.confidence - a.confidence || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

const fileOfKind = (kind: Kind): NoteFile | undefined => NOTE_FILES.find((file) => file.kinds.includes(kind));
const read = (path: string): string | null => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const withoutUpdated = (text: string): string => text.replace(/^updated: .*$/m, "");

function allRecords(store: Store): AnamnesisRecord[] {
  const out: AnamnesisRecord[] = [];
  for (let offset = 0; ; offset += 2000) {
    const page = store.list({ includeSensitive: true, statuses: ["confirmed", "draft", "candidate"], limit: 2000, offset });
    out.push(...page);
    if (page.length < 2000) return out;
  }
}

type Applied = NotesResponse["applied"];

/** Half one: the owner's edits of the files, read back into the records. */
function readBack(store: Store, dir: string, now: number, applied: Applied): { created: Map<string, Map<number, string>>; failed: Set<string>; contents: Map<string, string> } {
  const created = new Map<string, Map<number, string>>(), failed = new Set<string>(), changed = new Set<string>(), contents = new Map<string, string>();
  const state = store.notesState();
  const found = new Set<string>();
  const seen = new Set<string>();
  for (const file of ALL_FILES) {
    const content = read(join(dir, file.name));
    // A missing or empty file is a lost file, not a decision to reject everything in it: it is written again.
    if (content === null || !content.trim()) continue;
    contents.set(file.name, content);
    if (state.files.get(file.name) === sha(content)) continue;
    changed.add(file.name);
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      const bullet = parseBullet(line);
      if (!bullet) return;
      if (bullet.id) {
        if (seen.has(bullet.id)) return;
        seen.add(bullet.id); found.add(bullet.id);
        const record = store.get(bullet.id, { includeSensitive: true });
        if (!record) return;
        const base = state.lines.get(bullet.id)?.line;
        const baseBody = base ? parseBullet(base)?.body ?? "" : displayTextOf(record);
        try {
          if (!bullet.body) { found.delete(bullet.id); return; }
          if (bullet.body !== baseBody) {
            const text = bullet.body.slice(0, 600);
            store.edit(record.id, { title: text.slice(0, 160), statement: text, status: "confirmed" }, "edited in the notes file", now);
            applied.edited += 1;
          } else if ((bullet.checked || file !== REVIEW_FILE) && record.status !== "confirmed") {
            store.edit(record.id, { status: "confirmed" }, "confirmed in the notes file", now);
            applied.confirmed += 1;
          }
        } catch { applied.skipped += 1; failed.add(bullet.id); }
        return;
      }
      if (!bullet.body) return;
      const text = bullet.body.slice(0, 600);
      try {
        const result = store.upsert({
          kind: file.addKind, key: `note-${sha(text).slice(0, 12)}`, title: text.slice(0, 160), statement: text, firstSeen: now, lastSeen: now,
          ...(file.sensitive ? { sensitivity: "sensitive" as Sensitivity, attributes: { relation: "family" } } : {}),
        }, { actor: "owner", reason: "written in the notes file", now });
        if (!result.id || result.action === "invalid" || result.action === "ignored") { applied.skipped += 1; return; }
        const stored = store.get(result.id, { includeSensitive: true });
        if (stored && stored.status !== "confirmed") store.edit(result.id, { status: "confirmed" }, "written in the notes file", now);
        applied.created += 1;
        created.set(file.name, (created.get(file.name) ?? new Map()).set(index, result.id));
      } catch { applied.skipped += 1; }
    });
  }
  // A line that was written and is now gone from a file that still has content: the owner took it out.
  for (const [id, { file, line }] of state.lines) {
    if (!changed.has(file) || found.has(id) || failed.has(id)) continue;
    const record = store.get(id, { includeSensitive: true });
    if (!record || record.status === "rejected" || !line) continue;
    try { store.edit(id, { status: "rejected" }, "removed from the notes file", now); applied.rejected += 1; } catch { applied.skipped += 1; }
  }
  return { created, failed, contents };
}

const displayTextOf = (record: AnamnesisRecord): string => clean(displayText(record, "ru")) || clean(record.title);

function build(file: NoteFile, now: number, existing: string | null, wanted: Array<{ id: string; line: string }>, created: Map<number, string> | undefined, failed: ReadonlySet<string>): { content: string; lines: Map<string, string> } {
  const byId = new Map(wanted.map((item) => [item.id, item.line]));
  const lines = new Map<string, string>();
  const placed = new Set<string>();
  let out: string[];
  if (existing === null || !existing.trim()) {
    out = [...frontMatter(now, file), "", `# ${file.title}`, "", file.intro, "", `<!-- ${HOW} -->`, ""];
    for (const item of wanted) { out.push(item.line); lines.set(item.id, item.line); placed.add(item.id); }
    return { content: `${out.join("\n")}\n`, lines };
  }
  const source = existing.split("\n");
  out = [];
  source.forEach((line, index) => {
    if (/^updated: /.test(line)) { out.push(`updated: ${new Date(now).toISOString()}`); return; }
    const bullet = parseBullet(line);
    if (!bullet) { out.push(line); return; }
    const id = bullet.id ?? created?.get(index) ?? null;
    if (!id) { out.push(line); return; }
    if (failed.has(id)) { out.push(line); placed.add(id); return; }
    const next = byId.get(id);
    if (next === undefined || placed.has(id)) return;
    out.push(next); lines.set(id, next); placed.add(id);
  });
  const missing = wanted.filter((item) => !placed.has(item.id));
  if (missing.length) {
    let at = -1;
    out.forEach((line, index) => { if (parseBullet(line)) at = index; });
    const added = missing.map((item) => item.line);
    if (at >= 0) out.splice(at + 1, 0, ...added);
    else { while (out.length && !out[out.length - 1]!.trim()) out.pop(); out.push("", ...added); }
    for (const item of missing) lines.set(item.id, item.line);
  }
  let content = out.join("\n");
  if (!content.endsWith("\n")) content += "\n";
  return { content, lines };
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
  try { chmodSync(path, 0o600); } catch { /* not ours to change */ }
}

function ensureDir(dir: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* a folder we do not own keeps its mode */ }
}

const statusOf = (dir: string | null, applied: Applied, written: number, error?: string): NotesResponse => ({
  dir,
  files: ALL_FILES.map((file) => {
    const path = dir ? join(dir, file.name) : "";
    const content = dir ? read(path) : null;
    return { name: file.name, path, exists: content !== null, records: content ? content.split("\n").filter((line) => parseBullet(line)?.id).length : 0 };
  }),
  applied, written, ...(error ? { error } : {}),
});

/** Where the files are and how full, without touching anything. */
export function notesStatus(dir: string | null): NotesResponse {
  return statusOf(dir, { created: 0, edited: 0, confirmed: 0, rejected: 0, skipped: 0 }, 0);
}

/** One pass: the owner's edits are read back, then the files are written from the records. Never throws; a failure is in the answer. */
export function syncNotes(store: Store, dir: string, now: number = Date.now()): NotesResponse {
  const applied: Applied = { created: 0, edited: 0, confirmed: 0, rejected: 0, skipped: 0 };
  let written = 0;
  try {
    ensureDir(dir);
    store.transaction(() => {
      const { created, failed, contents } = readBack(store, dir, now, applied);
      const records = allRecords(store);
      const heads = store.evidenceHeads();
      const wanted = new Map<string, Array<{ id: string; line: string }>>(ALL_FILES.map((file) => [file.name, []]));
      for (const file of [...NOTE_FILES, REVIEW_FILE]) {
        const mine = file === REVIEW_FILE ? records.filter((r) => r.status !== "confirmed" && fileOfKind(r.kind)) : records.filter((r) => r.status === "confirmed" && fileOfKind(r.kind) === file);
        wanted.set(file.name, order(file, mine).map((record) => ({ id: record.id, line: renderLine(record, heads, file === REVIEW_FILE) })));
      }
      for (const file of ALL_FILES) {
        const path = join(dir, file.name);
        const existing = read(path);
        // The file moved since it was read back (the owner is typing in it): its lines are read at the next pass.
        if (contents.has(file.name) && contents.get(file.name) !== existing) continue;
        const { content, lines } = build(file, now, existing, wanted.get(file.name)!, created.get(file.name), failed);
        // The state stays on the line we last wrote for a line the owner changed and we could not apply, so the next pass tries again.
        for (const id of failed) { const old = store.notesState().lines.get(id); if (old && old.file === file.name) lines.set(id, old.line); }
        if (existing === null || withoutUpdated(existing) !== withoutUpdated(content)) {
          if (existing !== null && read(path) !== existing) continue;   // changed under us: the next pass reads it
          atomicWrite(path, content); written += 1;
          store.saveNotesState(file.name, sha(content), lines, now);
        } else store.saveNotesState(file.name, sha(existing), lines, now);
      }
    });
    return statusOf(dir, applied, written);
  } catch (cause) {
    return statusOf(dir, applied, written, cause instanceof Error ? cause.message.slice(0, 300) : String(cause));
  }
}

