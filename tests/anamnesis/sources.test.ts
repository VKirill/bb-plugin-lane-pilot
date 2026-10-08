import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSources } from "../../src/rooms/anamnesis/collect";
import { fragmentJudgment } from "../../src/rooms/anamnesis/judgment";
import { openStore, type Store } from "../../src/rooms/anamnesis/store";
import { discoverRepos, spread } from "../../src/rooms/anamnesis/sources/common";
import { parseRegistry, scanJournals, scanRegistry } from "../../src/rooms/anamnesis/sources/docs";
import { parseLog, safeRemote, scanGit } from "../../src/rooms/anamnesis/sources/git";
import { parseFrontMatter, recordsFromBbCatalog, scanBbMemory, scanClaudeMemory } from "../../src/rooms/anamnesis/sources/memories";

const tmp = () => mkdtempSync(join(tmpdir(), "anamnesis-src-"));
const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const DAY = 86_400_000;
let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

function makeRepo(dir: string, commits: Array<{ email: string; file: string; date: string }>) {
  mkdirSync(dir, { recursive: true });
  const git = (args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { cwd: dir, env: { ...process.env, ...env }, stdio: "pipe" });
  git(["init", "-q"]);
  commits.forEach((commit, i) => {
    write(join(dir, commit.file), `content ${i}`);
    git(["add", "-A"]);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", `change ${i}`], {
      GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: commit.email, GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: commit.email,
      GIT_AUTHOR_DATE: commit.date, GIT_COMMITTER_DATE: commit.date,
    });
  });
}

describe("git source", () => {
  it("parses the log format", () => {
    expect(parseLog("\u0001abc123\u001f1700000000\u001fa@b.c\nsrc/a.ts\nREADME.md\n\u0001def456\u001f1700000100\u001fa@b.c\nx.py\n")).toEqual([
      { sha: "abc123", at: 1_700_000_000_000, email: "a@b.c", files: ["src/a.ts", "README.md"] },
      { sha: "def456", at: 1_700_000_100_000, email: "a@b.c", files: ["x.py"] },
    ]);
  });

  it("never keeps credentials of a remote", () => {
    expect(safeRemote("https://user:ghp_secrettoken123@github.com/VKirill/repo.git")).toBe("github.com/VKirill/repo");
    expect(safeRemote("git@github.com:VKirill/repo.git")).toBe("github.com/VKirill/repo");
    expect(safeRemote("")).toBeNull();
  });

  it("finds repositories, skipping worktree files, node_modules and .claude", async () => {
    const root = tmp();
    mkdirSync(join(root, "a", ".git"), { recursive: true });
    mkdirSync(join(root, "b", "c", ".git"), { recursive: true });
    mkdirSync(join(root, "node_modules", "x", ".git"), { recursive: true });
    mkdirSync(join(root, ".claude", "worktrees", "w", ".git"), { recursive: true });
    write(join(root, "d", ".git"), "gitdir: /elsewhere");
    expect((await discoverRepos([root])).map((p) => p.slice(root.length))).toEqual(["/a", "/b/c"]);
  });

  it("makes projects and skills from the owner's commits only, with commit pointers and no messages", async () => {
    const root = tmp();
    const base = Date.now() - 100 * DAY;
    const at = (n: number) => new Date(base + n * DAY).toISOString();
    makeRepo(join(root, "proj-a"), [
      { email: "owner@example.com", file: "a.ts", date: at(0) }, { email: "owner@example.com", file: "b.ts", date: at(1) },
      { email: "owner@example.com", file: "c.tsx", date: at(2) }, { email: "bot@example.com", file: "bot.py", date: at(3) },
      { email: "owner@example.com", file: "d.py", date: at(4) },
    ]);
    makeRepo(join(root, "Клиенты", "acme-site"), [{ email: "owner@example.com", file: "index.html", date: at(5) }]);
    makeRepo(join(root, "someone-else"), [{ email: "bot@example.com", file: "z.ts", date: at(6) }]);
    const scan = await scanGit({ roots: [root], authors: ["owner@example.com"], since: base - DAY, until: Date.now(), home: root });
    expect(scan.stats).toMatchObject({ repos: 3, reposWithCommits: 2, commits: 5 });
    const projects = scan.records.filter((r) => r.kind === "project");
    expect(projects.map((p) => p.key).sort()).toEqual(["acme-site", "proj-a"]);
    const acme = projects.find((p) => p.key === "acme-site")!;
    expect(acme.sensitivity).toBe("sensitive");
    const a = projects.find((p) => p.key === "proj-a")!;
    expect(a.attributes).toMatchObject({ commits: 4, path: "~/proj-a" });
    expect(a.evidence[0]!.ref).toMatch(/^proj-a@[0-9a-f]{10}$/);
    expect(JSON.stringify(scan.records)).not.toMatch(/change \d/);
    const skills = scan.records.filter((r) => r.kind === "skill");
    expect(skills.map((s) => s.key)).toEqual(["lang:TypeScript"]);   // 3 TypeScript commits reach the threshold, 1 Python commit does not
  });

  it("says why nothing is read when no author is configured", async () => {
    const scan = await scanGit({ roots: [tmp()], authors: [], since: 0, until: 1, home: "/h" });
    expect(scan.note).toMatch(/no author/);
  });

  it("spreads samples evenly, keeping the ends", () => {
    expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)).toEqual([1, 4, 7, 10]);
    expect(spread([1, 2], 5)).toEqual([1, 2]);
  });
});

describe("journal and registry", () => {
  it("makes one dated event per journal file from the heading, with the chat and no body", async () => {
    const root = tmp();
    const journal = join(root, "BB-сервис", "docs", "project-life", "journal");
    write(join(journal, "2026-10-07-vk-phase-c-thr_abc123xyz.md"), "# Ядро vk: база 0.45.0\n\n- **Чат:** `.bb/chats/thr_abc123xyz/artifacts/x.md`\n\nSECRET BODY LINE\n");
    write(join(journal, "2026-09", "2026-09-14.md"), "## Агентство: основной отдел\n\ntext");
    write(join(journal, "notes.md"), "no heading here");
    const scan = await scanJournals([root], 0, Date.now() + DAY);
    expect(scan.items).toBe(3);
    const byTitle = Object.fromEntries(scan.records.map((r) => [r.title, r]));
    expect(byTitle["Ядро vk: база 0.45.0"]!.attributes).toMatchObject({ chat: "thr_abc123xyz", project: "BB-сервис" });
    expect(byTitle["Ядро vk: база 0.45.0"]!.firstSeen).toBe(Date.UTC(2026, 9, 7, 12));
    expect(byTitle["Агентство: основной отдел"]!.firstSeen).toBe(Date.UTC(2026, 8, 14, 12));
    expect(byTitle["notes"]).toBeDefined();
    expect(JSON.stringify(scan.records)).not.toContain("SECRET BODY");
    expect((await scanJournals([root], Date.UTC(2026, 9, 1), Date.now() + DAY)).records.map((r) => r.title)).toContain("Ядро vk: база 0.45.0");
  });

  it("reads project and plugin rows of the registry tables and ignores other tables", async () => {
    const text = [
      "# Реестр", "", "Снимок: 2026-09-12, Mac mini.", "", "## Машины и проекты", "", "| Объект | Host / root | Роль |", "|---|---|---|",
      "| BB-сервис | Mac mini `host_x`, `/Users/a/BB-сервис` | Основной центр |", "", "## Локальные плагины: фактический source", "",
      "| ID | Версия | Путь |", "|---|---|---|", "| `chime` | 0.1.0 / running | `/p/chime` |", "", "## Прочее", "", "| a | b |", "|---|---|", "| skip | me |",
    ].join("\n");
    expect(parseRegistry(text).map((r) => [r.section, r.cells[0]])).toEqual([["Машины и проекты", "BB-сервис"], ["Локальные плагины: фактический source", "chime"], ["Прочее", "skip"]]);
    const root = tmp();
    write(join(root, "BB-сервис", "docs", "REGISTRY.md"), text);
    const scan = await scanRegistry([root], Date.now());
    expect(scan.records.map((r) => `${r.kind}:${r.key}`).sort()).toEqual(["project:registry:BB-сервис", "tool:plugin:chime"]);
    expect(scan.records[0]!.firstSeen).toBe(Date.UTC(2026, 8, 12, 12));
  });
});

describe("existing memories", () => {
  it("reads only front matter of Claude memory topic files and maps their types", async () => {
    const home = tmp();
    const dir = join(home, ".claude", "projects", "-Users-a-proj", "memory");
    write(join(dir, "MEMORY.md"), "- index");
    write(join(dir, "reports.md"), "---\nname: Reports in Russian\ndescription: Owner wants short reports in Russian\ntype: feedback\n---\nBODY THAT MUST NOT BE COPIED");
    write(join(dir, "who.md"), "---\nname: Role\ndescription: Runs a small agency\ntype: user\n---\nbody");
    write(join(dir, "nested.md"), "---\nname: Nested type\ndescription: type sits under metadata\nmetadata:\n  type: user\n---\nbody");
    write(join(dir, "ref.md"), "---\nname: Link\ndescription: dashboard url\ntype: reference\n---\nbody");
    write(join(dir, "nofront.md"), "just text");
    utimesSync(join(dir, "who.md"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const scan = await scanClaudeMemory(home);
    expect(scan.items).toBe(5);
    expect(scan.records.map((r) => `${r.kind}|${r.title}`).sort()).toEqual(["fact|Nested type", "fact|Role", "preference|Reports in Russian"]);
    expect(scan.records.find((r) => r.title === "Role")!.firstSeen).toBe(1_700_000_000_000);
    expect(JSON.stringify(scan.records)).not.toContain("MUST NOT");
    expect(parseFrontMatter("---\nname: A\n---")).toEqual({ name: "A" });
  });

  it("maps BB global memories and skips how-to ones; a missing bb is a note, not a failure", async () => {
    const scan = recordsFromBbCatalog([
      { id: "mem_1", name: "tg-style", summary: "Rich Message in Telegram", kind: "preference", version: 2, updatedAt: 1_700_000_000_000 },
      { id: "mem_2", name: "deploy-steps", summary: "how to deploy", kind: "procedure", updatedAt: 1 },
    ]);
    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]).toMatchObject({ kind: "preference", key: "bbmem:tg-style" });
    expect(scan.records[0]!.evidence[0]!.ref).toBe("mem_1@v2");
    expect(scan.note).toMatch(/skipped/);
    const missing = await scanBbMemory(async () => { throw new Error("spawn bb ENOENT"); });
    expect(missing.records).toEqual([]);
    expect(missing.note).toMatch(/unavailable/);
    const ok = await scanBbMemory(async () => JSON.stringify({ memories: [{ id: "m", name: "n", summary: "s", kind: "fact", updatedAt: 5 }] }));
    expect(ok.records).toHaveLength(1);
  });
});

describe("collect: plan against run", () => {
  const seams = (records: number) => ({ home: "/h", scans: {
    "claude-memory": async () => ({ source: "claude-memory" as const, items: records, records: Array.from({ length: records }, (_, i) => ({
      kind: "fact" as const, key: `f${i}`, title: i === 0 ? "wife is ill" : `fact ${i}`, evidence: [{ source: "claude-memory" as const, ref: `p/f${i}`, at: 1000 + i }] })) }),
  } });
  const request = { mode: "plan" as const, sources: ["claude-memory" as const], roots: ["/x"], authors: ["a"], since: 0, until: 5000 };

  it("a plan counts by the real rules and changes nothing; a run stores and advances the checkpoint", async () => {
    store = openStore(":memory:");
    const plan = await collectSources(request, store, seams(3));
    expect(plan.sources[0]).toMatchObject({ source: "claude-memory", items: 3, records: 3, outcome: { created: 3 }, byKind: { fact: 3 }, bySensitivity: { sensitive: 1, private: 2 } });
    expect(store.counts().records).toBe(0);
    expect(store.checkpoint("claude-memory")).toBeNull();
    const run = await collectSources({ ...request, mode: "run" }, store, seams(3));
    expect(run.sources[0]!.outcome).toEqual({ created: 3 });
    expect(store.counts().records).toBe(3);
    expect(store.checkpoint("claude-memory")!.at).toBe(5000);
    const again = await collectSources({ ...request, mode: "run" }, store, seams(3));
    expect(again.sources[0]!.outcome).toEqual({ unchanged: 3 });
    expect(store.list({ includeSensitive: true }).every((r) => r.status === "draft")).toBe(true);
  });

  it("skips a source the owner switched off and reports a failing source without stopping the others", async () => {
    store = openStore(":memory:");
    store.setSource("claude-memory", false);
    const off = await collectSources(request, store, seams(2));
    expect(off.sources[0]).toMatchObject({ enabled: false, records: 0, note: "switched off" });
    store.setSource("claude-memory", true);
    const mixed = await collectSources({ ...request, sources: ["claude-memory", "journal"] }, store, { ...seams(1), scans: { ...seams(1).scans, journal: async () => { throw new Error("disk gone"); } } });
    expect(mixed.sources.map((s) => [s.source, s.records, s.error])).toEqual([["claude-memory", 1, undefined], ["journal", 0, "disk gone"]]);
  });
});

describe("the fragment judgment", () => {
  const answers = (kind: Record<string, number>, about: number, sensitive: number) => ({
    kind: { type: "choice" as const, choice: Object.entries(kind).sort((a, b) => b[1] - a[1])[0]![0], probabilities: kind, confidence: 0.9 },
    about_owner: { type: "noul" as const, noul: about }, sensitive: { type: "noul" as const, noul: sensitive },
  });
  const t = Object.fromEntries(Object.entries(fragmentJudgment.thresholds).map(([k, v]) => [k, v.default]));
  const decide = (a: ReturnType<typeof answers>) => (fragmentJudgment.decide(a, t, { text: "x" }) as { decision: { kind: string } }).decision;

  it("keeps a clear kind about the owner and drops tasks, questions and unclear fragments", () => {
    expect(decide(answers({ preference: 0.8, nothing: 0.1, fact: 0.1 }, 0.9, 0.1)).kind).toBe("preference");
    expect(decide(answers({ nothing: 0.9, fact: 0.1 }, 0.1, 0))).toMatchObject({ kind: "nothing" });
    expect(decide(answers({ skill: 0.8, nothing: 0.2 }, 0.2, 0)).kind).toBe("nothing");
    expect(decide(answers({ skill: 0.4, project: 0.38, nothing: 0.22 }, 0.9, 0)).kind).toBe("nothing");
  });
  it("falls back to nothing and sends only the fragment text", () => {
    expect(fragmentJudgment.fallback({ text: "x" }).kind).toBe("nothing");
    expect(fragmentJudgment.stateBuilder({ text: "hello" })).toEqual({ fragment: "hello" });
  });
});
