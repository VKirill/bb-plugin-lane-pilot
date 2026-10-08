import { basename } from "node:path";
import { discoverRepos, homeRelative, isClientPath, monthOf, runGit, spread, type SourceRecord, type SourceScan } from "./common";

/**
 * The owner's own commits (A3): one project per repository with commits by the owner in the window, one skill per language they
 * touched. Evidence is a commit pointer (`repo@sha`) with the commit time; commit messages and diffs are never read into the store.
 */
export const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", sh: "Shell", bash: "Shell", zsh: "Shell", css: "CSS", scss: "CSS", html: "HTML", sql: "SQL", rs: "Rust", go: "Go", java: "Java",
  kt: "Kotlin", swift: "Swift", php: "PHP", rb: "Ruby", c: "C", h: "C", cpp: "C++", cc: "C++", lua: "Lua", yml: "YAML", yaml: "YAML",
};
const MIN_COMMITS_FOR_SKILL = 3;

export type GitCommit = { sha: string; at: number; email: string; files: string[] };

export function parseLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const block of output.split("\u0001")) {
    if (!block.trim()) continue;
    const [head, ...files] = block.split("\n");
    const [sha, ct, email] = (head ?? "").split("\u001f");
    if (!sha || !ct) continue;
    commits.push({ sha, at: Number(ct) * 1000, email: email ?? "", files: files.map((f) => f.trim()).filter(Boolean) });
  }
  return commits;
}

/** `https://user:token@host/a/b.git` becomes `host/a/b`: a remote may carry credentials and must never be stored with them. */
export function safeRemote(url: string): string | null {
  const text = url.trim();
  if (!text) return null;
  const ssh = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?$/.exec(text);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try { const parsed = new URL(text); return `${parsed.host}${parsed.pathname.replace(/\.git$/, "")}`; } catch { return null; }
}

export type GitOptions = {
  roots: readonly string[]; authors: readonly string[]; since: number; until: number; home: string;
  /** Test seam; the host runs real git. */
  git?: (args: string[], cwd: string) => Promise<string>;
};

export async function scanGit(options: GitOptions): Promise<SourceScan & { stats: { repos: number; reposWithCommits: number; commits: number; filesTouched: number } }> {
  const git = options.git ?? runGit;
  const repos = await discoverRepos(options.roots);
  const records: SourceRecord[] = [];
  const skills = new Map<string, { commits: Array<{ at: number; ref: string }>; files: number; repos: Set<string> }>();
  let reposWithCommits = 0, commitTotal = 0, fileTotal = 0;
  if (!options.authors.length) return { source: "git", items: 0, records, note: "no author configured: set one with `bb lane-pilot anamnesis config --authors a,b`", stats: { repos: repos.length, reposWithCommits, commits: 0, filesTouched: 0 } };

  for (const repo of repos) {
    let commits: GitCommit[];
    try {
      const args = ["log", "--no-merges", `--since=${new Date(options.since).toISOString()}`, `--until=${new Date(options.until).toISOString()}`,
        ...options.authors.map((author) => `--author=${author}`), "--regexp-ignore-case", "--format=%x01%H%x1f%ct%x1f%ae", "--name-only"];
      commits = parseLog(await git(args, repo));
    } catch { continue; }
    if (!commits.length) continue;
    reposWithCommits += 1; commitTotal += commits.length;
    const name = basename(repo);
    const byMonth: Record<string, number> = {};
    const langCommits = new Map<string, number>();
    for (const commit of commits) {
      byMonth[monthOf(commit.at)] = (byMonth[monthOf(commit.at)] ?? 0) + 1;
      const touched = new Set<string>();
      for (const file of commit.files) {
        fileTotal += 1;
        const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
        const language = LANGUAGES[ext];
        if (!language) continue;
        const entry = skills.get(language) ?? { commits: [], files: 0, repos: new Set<string>() };
        entry.files += 1; entry.repos.add(name);
        skills.set(language, entry);
        touched.add(language);
      }
      for (const language of touched) {
        skills.get(language)!.commits.push({ at: commit.at, ref: `${name}@${commit.sha.slice(0, 10)}` });
        langCommits.set(language, (langCommits.get(language) ?? 0) + 1);
      }
    }
    commits.sort((a, b) => a.at - b.at);
    const first = commits[0]!, last = commits.at(-1)!;
    let remote: string | null = null;
    try { remote = safeRemote(await git(["remote", "get-url", "origin"], repo)); } catch { remote = null; }
    const topLanguages = [...langCommits].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([language]) => language);
    records.push({
      kind: "project", key: name, title: name,
      statement: `${commits.length} commits by the owner, ${monthOf(first.at)} to ${monthOf(last.at)}${topLanguages.length ? `; ${topLanguages.join(", ")}` : ""}`,
      attributes: { origin: "git", commits: commits.length, byMonth, languages: topLanguages, path: homeRelative(repo, options.home), ...(remote ? { remote } : {}), ...(isClientPath(repo) ? { relation: "client-work" } : {}) },
      ...(isClientPath(repo) ? { sensitivity: "sensitive" as const } : {}),
      confidence: 0.9, firstSeen: first.at, lastSeen: last.at,
      evidence: spread(commits.map((c) => ({ source: "git" as const, ref: `${name}@${c.sha.slice(0, 10)}`, at: c.at })), 12),
    });
  }

  for (const [language, entry] of skills) {
    if (entry.commits.length < MIN_COMMITS_FOR_SKILL) continue;
    entry.commits.sort((a, b) => a.at - b.at);
    records.push({
      kind: "skill", key: `lang:${language}`, title: language,
      statement: `Commits touching ${entry.files} ${language} files in ${entry.repos.size} repositories, ${monthOf(entry.commits[0]!.at)} to ${monthOf(entry.commits.at(-1)!.at)}`,
      attributes: { origin: "git", category: "technical", commits: entry.commits.length, files: entry.files, repos: entry.repos.size },
      confidence: 0.8, firstSeen: entry.commits[0]!.at, lastSeen: entry.commits.at(-1)!.at,
      evidence: spread(entry.commits.map((c) => ({ source: "git" as const, ref: c.ref, at: c.at })), 20),
    });
  }
  return { source: "git", items: commitTotal, records, stats: { repos: repos.length, reposWithCommits, commits: commitTotal, filesTouched: fileTotal } };
}
