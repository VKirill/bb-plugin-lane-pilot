import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { executeRequest } from "../../src/rooms/anamnesis/host";
import { NOTE_FILES, REVIEW_FILE, notesStatus, parseBullet, syncNotes } from "../../src/rooms/anamnesis/notes";
import { openStore, type Store } from "../../src/rooms/anamnesis/store";

/** The Markdown files are the source of truth: written from the records, and the owner's edits are read back before they are written again. */
const T0 = Date.UTC(2026, 9, 1), T1 = Date.UTC(2026, 9, 8);
let store: Store, dir: string, clock: number;
const sync = () => syncNotes(store, dir, (clock += 1000));
const file = (name: string) => readFileSync(join(dir, name), "utf8");
const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
const told = (record: Record<string, unknown>) => store.upsert(record, { actor: "owner", reason: "told", now: T0 });
const found = (record: Record<string, unknown>) => store.upsert(record, { actor: "auto:jev-fragment", reason: "found", now: T1 });

beforeEach(() => {
  store = openStore(":memory:");
  dir = join(mkdtempSync(join(tmpdir(), "anamnesis-notes-")), "Обо мне");
  clock = T1;
  told({ kind: "self", key: "values", title: "Ценю честность", statement: "Ценю честность и прямоту в работе" });
  told({ kind: "knowledge", key: "seo", title: "SEO", statement: "Знаю SEO и контент-маркетинг" });
  told({ kind: "skill", key: "blender", title: "Blender", statement: "Делаю анимацию в Blender" });
  told({ kind: "person", key: "anna", title: "Анна", statement: "Жена Анна, врач", attributes: { relation: "family" } });
  told({ kind: "hobby", key: "cycling", title: "Велосипед", statement: "Катаюсь на велосипеде по выходным" });
  told({ kind: "interest", key: "film", title: "Кино", statement: "Люблю кино Тарковского" });
  told({ kind: "event", key: "move", title: "Переезд", statement: "Переехал в Мадрид", firstSeen: Date.UTC(2024, 2, 5), lastSeen: Date.UTC(2024, 2, 5) });
  told({ kind: "preference", key: "reports", title: "Отчёты", statement: "Отчёты по-русски, коротко" });
  found({ kind: "hobby", key: "msg-1", title: "Играю на гитаре", statement: "Играю на гитаре по вечерам", status: "draft", confidence: 0.9,
    evidence: [{ source: "bb-message", ref: "thr_abc123:7:0", at: Date.UTC(2026, 8, 20) }] });
});

describe("the portrait as Markdown files", () => {
  it("writes the files: confirmed facts by section, family included, new findings in «На проверку», each with dates, an evidence pointer and a hidden marker", () => {
    const result = sync();
    expect(result).toMatchObject({ dir, written: 9 });
    expect(result.error).toBeUndefined();
    expect(readdirSync(dir).sort()).toEqual([...NOTE_FILES, REVIEW_FILE].map((f) => f.name).sort());
    expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(join(dir, "Хобби.md")).mode & 0o777).toString(8)).toBe("600");

    const hobby = file("Хобби.md");
    expect(hobby).toMatch(/^---\nupdated: 2026-10-08T/);
    expect(hobby).toContain("# Хобби");
    expect(hobby).toMatch(/^- Велосипед — Катаюсь на велосипеде по выходным _\(2026-10-01 · вручную 2026-10-01\)_ <!-- a:hobby:cycling -->$/m);
    expect(hobby).not.toContain("гитаре");   // not confirmed yet
    expect(file("Семья и близкие.md")).toContain("Жена Анна, врач");   // family is written: it is the owner's own note
    expect(file("Хронология.md")).toMatch(/- Переезд — Переехал в Мадрид _\(2024-03-05 · вручную 2026-10-01\)_ <!-- a:event:move -->/);
    const review = file("На проверку.md");
    expect(review).toMatch(/^- \[ \] Играю на гитаре по вечерам _\(хобби · 2026-09-20 · @thread:thr_abc123\)_ <!-- a:hobby:msg-1 -->$/m);
    // No record ids in the readable part of a line: they live only in the comment.
    expect(file("Умения.md").replace(/<!--.*?-->/g, "")).not.toMatch(/skill:|blender:/);
  });

  it("is quiet when nothing changed: a second pass writes no file", () => {
    sync();
    expect(sync().written).toBe(0);
    expect(sync()).toMatchObject({ applied: { created: 0, edited: 0, confirmed: 0, rejected: 0, skipped: 0 } });
  });

  it("reads the owner's edits back: a changed line is an edit, a new line a confirmed record, a removed line a rejection, a ticked box a confirmation", () => {
    sync();
    // changed
    write("Хобби.md", file("Хобби.md").replace("Катаюсь на велосипеде по выходным", "Катаюсь на шоссейном велосипеде"));
    // new line (no marker), in the family file, plus an owner's own heading and prose that must survive
    write("Семья и близкие.md", `${file("Семья и близкие.md")}\n## Мои заметки\nЭто мой абзац, его никто не трогает.\n- Дочь Маша, 7 лет\n`);
    // removed
    write("Предпочтения.md", file("Предпочтения.md").split("\n").filter((line) => !line.includes("a:preference:reports")).join("\n"));
    // ticked, and a second one edited in the review file
    write("На проверку.md", file("На проверку.md").replace("- [ ] Играю", "- [x] Играю"));

    const result = sync();
    expect(result.applied).toEqual({ created: 1, edited: 1, confirmed: 1, rejected: 1, skipped: 0 });

    expect(store.get("hobby:cycling", { includeSensitive: true })).toMatchObject({ status: "confirmed", statement: "Велосипед — Катаюсь на шоссейном велосипеде" });
    expect(store.history("hobby:cycling")[0]).toMatchObject({ actor: "owner", reason: "edited in the notes file" });
    expect(store.get("preference:reports")).toMatchObject({ status: "rejected" });
    expect(store.get("hobby:msg-1")).toMatchObject({ status: "confirmed" });
    const added = store.list({ includeSensitive: true, kinds: ["person"] }).find((r) => r.statement === "Дочь Маша, 7 лет")!;
    expect(added).toMatchObject({ status: "confirmed", sensitivity: "sensitive" });

    // The files now say the same: the confirmed finding moved to its section, the rejected line is gone, the new line got its marker, the owner's prose stayed.
    expect(file("Хобби.md")).toContain("Играю на гитаре по вечерам");
    expect(file("Хобби.md")).toContain("шоссейном велосипеде");
    expect(file("На проверку.md")).not.toContain("гитаре");
    expect(file("Предпочтения.md")).not.toContain("Отчёты по-русски");
    const family = file("Семья и близкие.md");
    expect(family).toContain("## Мои заметки\nЭто мой абзац, его никто не трогает.");
    expect(family).toContain(`Дочь Маша, 7 лет`);
    expect(family).toContain(`<!-- a:${added.id} -->`);
    expect(family.match(/Дочь Маша/g)).toHaveLength(1);
    expect(sync().written).toBe(0);
  });

  it("an edit of a finding in «На проверку» corrects and confirms it; a deleted finding is rejected and stays rejected", () => {
    found({ kind: "interest", key: "msg-2", title: "Шахматы", statement: "Интересуюсь шахматами", status: "candidate", evidence: [{ source: "bb-message", ref: "thr_x:1:0", at: T1 }] });
    sync();
    let review = file("На проверку.md");
    review = review.replace("Интересуюсь шахматами", "Интересуюсь шахматными этюдами");
    review = review.split("\n").filter((line) => !line.includes("a:hobby:msg-1")).join("\n");
    write("На проверку.md", review);
    sync();
    expect(store.get("interest:msg-2")).toMatchObject({ status: "confirmed", statement: "Шахматы — Интересуюсь шахматными этюдами" });
    expect(store.get("hobby:msg-1")).toMatchObject({ status: "rejected" });
    expect(file("Интересы.md")).toContain("шахматными этюдами");
    // The same finding coming again from a later message cannot bring it back.
    expect(found({ kind: "hobby", key: "msg-1", title: "Играю на гитаре", statement: "Играю на гитаре по вечерам", evidence: [{ source: "bb-message", ref: "thr_abc123:9:0", at: T1 + 5 }] }).action).toBe("blocked");
    sync();
    expect(file("На проверку.md")).not.toContain("гитаре");
  });

  it("never overwrites an owner's edit when the machine finds something new in the meantime: both are in the file", () => {
    sync();
    write("Хобби.md", file("Хобби.md").replace("по выходным", "по выходным и в отпуске"));
    found({ kind: "hobby", key: "msg-3", title: "Бегаю", statement: "Бегаю по утрам", status: "draft", evidence: [{ source: "bb-message", ref: "thr_q:1:0", at: T1 + 10 }] });
    sync();
    expect(file("Хобби.md")).toContain("по выходным и в отпуске");
    expect(file("На проверку.md")).toContain("Бегаю по утрам");
    expect(store.get("hobby:cycling")!.statement).toBe("Велосипед — Катаюсь на велосипеде по выходным и в отпуске");
  });

  it("does not take a lost file for a decision: a deleted or emptied file is written again and nothing is rejected", () => {
    sync();
    rmSync(join(dir, "Умения.md"));
    write("Интересы.md", "");
    const result = sync();
    expect(result.applied.rejected).toBe(0);
    expect(file("Умения.md")).toContain("Делаю анимацию в Blender");
    expect(file("Интересы.md")).toContain("Люблю кино Тарковского");
    expect(store.get("skill:blender")).toMatchObject({ status: "confirmed" });
  });

  it("a forgotten record leaves its file; a line whose edit cannot be applied is kept as the owner wrote it", () => {
    sync();
    store.forget("event:move", T1 + 1);
    write("Хобби.md", file("Хобби.md").replace("Катаюсь на велосипеде по выходным", "API_KEY=abc секрет велосипеда"));
    write("Знания.md", file("Знания.md").replace("Знаю SEO и контент-маркетинг", "Знаю SEO -----BEGIN PRIVATE KEY-----"));
    const result = sync();
    expect(file("Хронология.md")).not.toContain("Мадрид");
    expect(result.applied.skipped).toBeGreaterThanOrEqual(1);
    expect(file("Знания.md")).toContain("-----BEGIN PRIVATE KEY-----");   // not overwritten; the owner sees it is still his line
    expect(store.get("knowledge:seo")!.statement).toBe("Знаю SEO и контент-маркетинг");
  });

  it("host operations keep the files in step: confirming in the tab moves the line, and no folder is touched without a notes dir", async () => {
    sync();
    await executeRequest({ op: "edit", id: "hobby:msg-1", patch: { status: "confirmed" }, reason: "confirmed in the Anamnesis tab" }, store, { now: T1 + 5000, notesDir: dir });
    expect(file("Хобби.md")).toContain("Играю на гитаре по вечерам");
    expect(file("На проверку.md")).not.toContain("гитаре");
    const other = join(dir, "..", "elsewhere");
    await executeRequest({ op: "edit", id: "hobby:cycling", patch: { statement: "Катаюсь" }, reason: "t" }, store, { now: T1 + 6000 });
    expect(existsSync(other)).toBe(false);
    const status = (await executeRequest({ op: "notes" }, store, { notesDir: dir })) as ReturnType<typeof notesStatus>;
    expect(status.files.find((f) => f.name === "Умения.md")).toMatchObject({ exists: true, records: 1 });
    expect(status.dir).toBe(dir);
  });

  it("parses a bullet: text without its note and marker, the id, the box", () => {
    expect(parseBullet("- [x] Текст со скобками (раз) _(хобби · 2026-09-20 · @thread:thr_1)_ <!-- a:hobby:x -->")).toEqual({ id: "hobby:x", checked: true, body: "Текст со скобками (раз)" });
    expect(parseBullet("* Просто строка")).toEqual({ id: null, checked: false, body: "Просто строка" });
    expect(parseBullet("## Заголовок")).toBeNull();
  });
});
