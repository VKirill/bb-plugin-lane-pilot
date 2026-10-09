import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAsync } from "@lane-pilot/kit";
import { prepareWorktree } from "./git-integrate";
import { extractFailingFiles } from "./gate-output";

/**
 * The integration gate's work on the machine that holds the project: the gate command, the commit it ran on, and the
 * bisect that names the first bad commit. The hub only decides and tells; it has no copy of the project (the project may
 * live on another host), so none of this runs there.
 */

const GATE_OUTPUT_LIMIT = 4 * 1024 * 1024;

export async function runGateOnHost(input:{basePath:string;command:string;timeoutSec:number}):Promise<{exitCode:number;stdout:string;stderr:string;head:string|null}> {
  const ran=await spawnAsync("/bin/bash",["-lc",input.command],{cwd:input.basePath,timeout:input.timeoutSec*1000,maxBuffer:64*1024*1024});
  const head=await spawnAsync("git",["rev-parse","HEAD"],{cwd:input.basePath,timeout:30_000});
  const killed=[ran.error?.message,ran.signal?`killed by ${ran.signal}`:null].filter(Boolean).join("; ");
  return {
    exitCode:ran.status??1,
    stdout:(ran.stdout??"").slice(-GATE_OUTPUT_LIMIT),
    stderr:[ran.stderr??"",killed].filter(Boolean).join("\n").slice(-GATE_OUTPUT_LIMIT),
    head:head.status===0&&head.stdout.trim()?head.stdout.trim():null,
  };
}

/**
 * `git bisect run` over goodSha..badSha in a scratch worktree of the base checkout, so the project's own checkout is never
 * moved off its branch while writers merge into it. The worktree gets the base's dependencies like a writer's.
 */
export async function bisectGateOnHost(input:{basePath:string;command:string;goodSha:string;badSha:string;timeoutSec:number}):Promise<{status:"found"|"none"|"failed";commit:string|null;reason:string|null}> {
  const dir=await mkdtemp(join(tmpdir(),"lp-gate-bisect-"));
  const scratch=join(dir,"wt");
  const git=(args:string[],cwd=scratch,timeout=60_000)=>spawnAsync("git",args,{cwd,timeout,maxBuffer:16*1024*1024});
  try {
    const added=await git(["worktree","add","--detach",scratch,input.badSha],input.basePath);
    if(added.status!==0) return {status:"failed",commit:null,reason:`worktree add: ${(added.stderr||added.stdout||"").trim().slice(0,300)}`};
    await prepareWorktree({basePath:input.basePath,worktreePath:scratch}).catch(()=>undefined);
    const start=await git(["bisect","start",input.badSha,input.goodSha]);
    if(start.status!==0) return {status:"failed",commit:null,reason:`bisect start: ${(start.stderr||start.stdout||"").trim().slice(0,300)}`};
    const run=await git(["bisect","run","/bin/bash","-lc",input.command],scratch,input.timeoutSec*1000);
    const match=`${run.stdout}\n${run.stderr}`.match(/([0-9a-f]{7,40}) is the first bad commit/);
    return match?{status:"found",commit:match[1]!,reason:null}:{status:"none",commit:null,reason:null};
  } finally {
    await git(["bisect","reset"]).catch(()=>undefined);
    await git(["worktree","remove","--force",scratch],input.basePath).catch(()=>undefined);
    await git(["worktree","prune"],input.basePath).catch(()=>undefined);
    await rm(dir,{recursive:true,force:true}).catch(()=>undefined);
  }
}

export type GateAttributeResult = {
  /** What each given commit changed, by its first parent: the paths and the workspaces (nearest package.json folders) they lie in. */
  commits: Record<string, { paths: string[]; workspaces: string[] }>;
  /** Per failing test, in the order given: its workspace folder and repository path (null when the host cannot place it), and whether it also fails on the base. */
  failing: Array<{ workspaceDir: string | null; path: string | null; preexisting: boolean | null }>;
  baseline: { status: "ran" | "skipped" | "failed"; reason: string | null };
};

const posixDir = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const joinPath = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);
const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/**
 * Which tasks can have broken which failing tests, answered on the machine that holds the project (a project on another host
 * has no path on the hub). Three facts: what each merged commit changed and in which workspace (the nearest package.json
 * folder); where each failing test lives (the turbo package name or the file path, to its workspace); and whether the failing
 * test files also fail on the base the batch started from, run alone in a scratch worktree there (failing on the base means the
 * batch did not break them).
 */
export async function attributeGateOnHost(input: {
  basePath: string; baseSha: string | null; commits: string[]; failing: Array<{ file: string; workspacePackage: string | null }>; timeoutSec: number;
}): Promise<GateAttributeResult> {
  const git = (args: string[], cwd = input.basePath, timeout = 60_000) => spawnAsync("git", args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 });
  const tracked = (await git(["ls-files", "-z"])).stdout.split("\0").filter(Boolean);
  const trackedSet = new Set(tracked);
  const packageDirs = new Set(tracked.filter((path) => path === "package.json" || path.endsWith("/package.json")).map(posixDir));
  const nearestPackageDir = (path: string): string => {
    for (let dir = posixDir(path); ; dir = posixDir(dir)) {
      if (packageDirs.has(dir)) return dir;
      if (!dir) return "";
    }
  };

  const commits: GateAttributeResult["commits"] = {};
  for (const sha of input.commits) {
    const parent = await git(["rev-parse", "--verify", "-q", `${sha}^1`]);
    const diff = parent.status === 0
      ? await git(["diff", "--name-only", "--relative", "-z", parent.stdout.trim(), sha])
      : await git(["show", "--name-only", "--format=", "--relative", "-z", sha]);
    if (diff.status !== 0) continue;
    const paths = diff.stdout.split("\0").filter(Boolean);
    commits[sha] = { paths, workspaces: [...new Set(paths.map(nearestPackageDir))] };
  }

  const packageNames = new Map<string, string>();
  if (input.failing.some((entry) => entry.workspacePackage)) {
    for (const dir of [...packageDirs].slice(0, 500)) {
      const parsed = await readFile(join(input.basePath, dir, "package.json"), "utf8").then((text) => JSON.parse(text) as { name?: unknown }, () => null);
      if (typeof parsed?.name === "string") packageNames.set(parsed.name, dir);
    }
  }
  const failing: GateAttributeResult["failing"] = input.failing.map((entry) => {
    const file = entry.file.replace(/^\.\//, "");
    const named = entry.workspacePackage ? packageNames.get(entry.workspacePackage) : undefined;
    if (named !== undefined) return { workspaceDir: named, path: joinPath(named, file), preexisting: null };
    if (trackedSet.has(file)) return { workspaceDir: nearestPackageDir(file), path: file, preexisting: null };
    const matches = tracked.filter((path) => path.endsWith(`/${file}`));
    if (matches.length === 1) return { workspaceDir: nearestPackageDir(matches[0]!), path: matches[0]!, preexisting: null };
    return { workspaceDir: null, path: null, preexisting: null };
  });

  const eligible = failing.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.path && TEST_FILE.test(entry.path));
  if (!input.baseSha || !eligible.length) return { commits, failing, baseline: { status: "skipped", reason: input.baseSha ? "no failing test file could be placed" : "no base commit" } };

  const dir = await mkdtemp(join(tmpdir(), "lp-gate-base-"));
  const scratch = join(dir, "wt");
  const deadline = Date.now() + input.timeoutSec * 1000;
  try {
    const added = await git(["worktree", "add", "--detach", scratch, input.baseSha]);
    if (added.status !== 0) return { commits, failing, baseline: { status: "failed", reason: `worktree add: ${(added.stderr || added.stdout || "").trim().slice(0, 300)}` } };
    await prepareWorktree({ basePath: input.basePath, worktreePath: scratch }).catch(() => undefined);
    const groups = new Map<string, typeof eligible>();
    for (const entry of eligible) groups.set(entry.workspaceDir ?? "", [...(groups.get(entry.workspaceDir ?? "") ?? []), entry]);
    for (const [workspaceDir, entries] of groups) {
      // A test file the base does not have cannot have failed there.
      const existing: typeof entries = [];
      for (const entry of entries) {
        if ((await git(["cat-file", "-e", `${input.baseSha}:${entry.path}`])).status === 0) existing.push(entry);
        else failing[entry.index]!.preexisting = false;
      }
      if (!existing.length) continue;
      const cwd = join(scratch, workspaceDir);
      const pkg = await readFile(join(cwd, "package.json"), "utf8").then((text) => JSON.parse(text) as { scripts?: { test?: unknown } }, () => null);
      const script = typeof pkg?.scripts?.test === "string" ? pkg.scripts.test : "";
      const runner = /\bjest\b/.test(script) && !/\bvitest\b/.test(script) ? "npx jest" : "npx vitest run";
      const relative = (entry: (typeof existing)[number]) => (workspaceDir ? entry.path!.slice(workspaceDir.length + 1) : entry.path!);
      const left = Math.max(60_000, deadline - Date.now());
      const ran = await spawnAsync("/bin/bash", ["-lc", `${runner} ${existing.map((entry) => shellQuote(relative(entry))).join(" ")}`], { cwd, timeout: left, maxBuffer: 64 * 1024 * 1024 });
      const named = new Set(extractFailingFiles(`${ran.stdout}\n${ran.stderr}`));
      for (const entry of existing) {
        failing[entry.index]!.preexisting = ran.status === 0 ? false : named.has(relative(entry)) ? true : named.size ? false : null;
      }
    }
    return { commits, failing, baseline: { status: "ran", reason: null } };
  } catch (cause) {
    return { commits, failing, baseline: { status: "failed", reason: cause instanceof Error ? cause.message.slice(0, 300) : String(cause) } };
  } finally {
    await git(["worktree", "remove", "--force", scratch]).catch(() => undefined);
    await git(["worktree", "prune"]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
