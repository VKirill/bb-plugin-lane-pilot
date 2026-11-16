import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import type { OwnerAsk } from "../../relay/server";
import {
  bootstrapKey, declinedKey, isWithin, repoNameFor, sameRemote, scopeKey, scopeQuestion, verifyReadback,
  type BootstrapRecord, type BootstrapStage, type GitProbe, type ScopeChoice,
} from "../logic";
import { baselineCommand, parseBaseline, parseProbe, probeCommand } from "../scripts";

type Ran = { exitCode: number; stdout: string; stderr: string };
type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };

export type ProjectGitDeps = {
  host: RunCommandHost;
  kv: Kv;
  ownerAsk: Pick<OwnerAsk, "ask">;
  log: (message: string) => void;
  /** An active run that works in this folder without Git (the folder, a folder inside it or above it); null when none. A live run is never converted. */
  activeLiveRun: (input: { hostId: string; root: string }) => Promise<string | null>;
  /** Drops cached repository metadata for the folder (project-folders' forgetGithub); absent: the stage is recorded as skipped. */
  invalidate?: (input: { hostId: string; root: string; url: string }) => Promise<void>;
  now?: () => number;
};

export type BootstrapResult =
  | { ok: true; root: string; fullName: string; url: string; commit: string; branch: string }
  | { ok: false; stage: BootstrapStage; code: string; detail: string; blocked?: Array<{ path: string; why: string }> };

export type ScopeResult =
  | { kind: "repo"; state: "origin" | "localNoOrigin"; root: string }
  | { kind: "chosen"; choice: ScopeChoice }
  | { kind: "declined"; reason: string }
  | { kind: "unknown"; reason: string }
  | { kind: "unavailable"; reason: string };

export type EnsureResult = Exclude<ScopeResult, { kind: "chosen" }> | { kind: "bootstrapped"; result: BootstrapResult };

export type ScopeInput = {
  threadId: string; hostId: string; projectRoot: string; sectionPath?: string | null;
  /** The task asking; a dismissal is kept for it so one task never asks twice. */
  taskKey?: string; locale?: "ru" | "en"; signal?: AbortSignal; timeoutMs?: number;
};

/** The form went away with Lane Pilot or the chat, not by the owner: no dismissal is kept. */
const NOT_THE_OWNER = new Set(["plugin-disposed", "server-restarted", "request-aborted", "thread-stopped", "thread-deleted"]);
const q = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
/** `gh` lends its own login to this one git call: no token is stored, no git config is changed. */
const GH_GIT = `git -c credential.helper= -c ${q("credential.helper=!gh auth git-credential")}`;
const clip = (text: string) => text.trim().slice(0, 300);

/**
 * Private Git for a folder without it: probe (P03.04), the one scope question (P03.05), the curated first commit (P03.06),
 * a private GitHub repository through the host's own `gh` login with an authenticated readback (P03.07), and a durable
 * record of each stage so a retry continues where the last attempt stopped and a lost answer never creates a second
 * repository (P03.08). Everything runs on the folder's own host.
 */
export function createProjectGit(deps: ProjectGitDeps) {
  const now = deps.now ?? Date.now;
  const asking = new Map<string, Promise<ScopeResult>>();
  const running = new Map<string, Promise<BootstrapResult>>();

  const run = (hostId: string, cwd: string, command: string, timeoutSec = 60): Promise<Ran> =>
    runOnHost(deps.host, { hostId, cwd, command, timeoutSec })
      .then((ran) => ({ exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }))
      .catch((cause: unknown): Ran => ({ exitCode: -1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }));

  const probe = async (hostId: string, folder: string): Promise<GitProbe> => parseProbe(await run(hostId, folder, probeCommand(), 30));

  async function resolveScope(input: ScopeInput): Promise<ScopeResult> {
    const project = await probe(input.hostId, input.projectRoot);
    const section = input.sectionPath && input.sectionPath !== input.projectRoot ? await probe(input.hostId, input.sectionPath) : null;
    const target = section ?? project;
    if (target.state === "unknown") return { kind: "unknown", reason: target.reason ?? "the folder could not be probed" };
    if (target.state !== "noGit") return { kind: "repo", state: target.state, root: target.root! };
    if (project.state === "unknown" || !target.cwd) return { kind: "unknown", reason: project.reason ?? "the project folder could not be probed" };
    const candidates: ScopeChoice[] = [];
    if (project.state === "noGit" && project.cwd && (!section || isWithin(target.cwd, project.cwd))) candidates.push({ scope: "project", root: project.cwd });
    if (section?.cwd && section.cwd !== project.cwd) candidates.push({ scope: "section", root: section.cwd });
    const key = scopeKey(input.hostId, project.cwd ?? input.projectRoot, section?.cwd ?? null);
    const saved = await deps.kv.get<ScopeChoice>(key);
    if (saved && candidates.some((c) => c.scope === saved.scope && c.root === saved.root)) return { kind: "chosen", choice: saved };
    if (input.taskKey && await deps.kv.get<string>(declinedKey(input.taskKey))) return { kind: "declined", reason: "the owner declined Git for this task" };
    let pending = asking.get(key);
    if (!pending) {
      pending = ask(input, candidates, key).finally(() => asking.delete(key));
      asking.set(key, pending);
    }
    return pending;
  }

  async function ask(input: ScopeInput, candidates: ScopeChoice[], key: string): Promise<ScopeResult> {
    const form = scopeQuestion(candidates, input.locale ?? "ru");
    const answer = await deps.ownerAsk.ask(input.threadId, { source: "pm", kind: "decision", ...form },
      { ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    if (answer.outcome === "unavailable") return { kind: "unavailable", reason: answer.reason };
    const picked = answer.outcome === "answered" && answer.choice ? candidates[Number(answer.choice.id) - 1] : undefined;
    if (picked) {
      await deps.kv.set(key, picked as never);
      return { kind: "chosen", choice: picked };
    }
    const reason = answer.outcome === "cancelled" ? answer.reason : `no scope picked: ${answer.text}`;
    if (input.taskKey && !(answer.outcome === "cancelled" && NOT_THE_OWNER.has(answer.reason))) await deps.kv.set(declinedKey(input.taskKey), reason as never);
    return { kind: "declined", reason };
  }

  function bootstrap(input: { hostId: string; root: string }): Promise<BootstrapResult> {
    const key = bootstrapKey(input.hostId, input.root);
    let pending = running.get(key);
    if (!pending) {
      pending = stages(input.hostId, input.root, key).finally(() => running.delete(key));
      running.set(key, pending);
    }
    return pending;
  }

  async function stages(hostId: string, root: string, key: string): Promise<BootstrapResult> {
    const rec: BootstrapRecord = (await deps.kv.get<BootstrapRecord>(key)) ?? { v: 1, hostId, root };
    const save = () => deps.kv.set(key, rec as never);
    const fail = async (stage: BootstrapStage, code: string, detail: string, blocked?: Array<{ path: string; why: string }>): Promise<BootstrapResult> => {
      rec.lastError = { stage, code, detail, at: now() };
      await save();
      deps.log(`project git ${hostId}:${root}: ${stage} stopped: ${code} ${detail}`);
      return { ok: false, stage, code, detail, ...(blocked ? { blocked } : {}) };
    };
    const git = (args: string, timeoutSec?: number) => run(hostId, root, `git ${args}`, timeoutSec);
    if (rec.doneAt && rec.repo?.fullName && rec.repo.cloneUrl && rec.baseline && rec.push) {
      return { ok: true, root, fullName: rec.repo.fullName, url: rec.repo.cloneUrl, commit: rec.baseline.commit, branch: rec.push.branch };
    }

    const live = await deps.activeLiveRun({ hostId, root });
    if (live) return fail("guard", "live_run_active", `run ${live} works in this folder without Git; it is not converted while it runs`);

    const found = await probe(hostId, root);
    if (found.state === "unknown") return fail("probe", "probe_unknown", found.reason ?? "the folder could not be probed");
    if (found.cwd && found.cwd !== root) return fail("probe", "not_canonical", `the host resolves ${root} to ${found.cwd}; pass the host's own path`);
    if (found.root && found.root !== root) return fail("probe", "inside_other_repo", `the folder belongs to the repository at ${found.root}`);
    if (found.state === "origin" && !(rec.origin && sameRemote(found.origin!, rec.origin.url))) {
      return fail("probe", "already_has_origin", `the repository already has origin ${found.origin}`);
    }

    if (!rec.baseline) {
      if (found.state !== "noGit" && !found.hasCommit && !rec.baselineStartedAt) return fail("baseline", "unborn_repo", "a repository without commits that Lane Pilot did not start: commit its files first");
      const resume = found.state !== "noGit";
      if (!resume) { rec.baselineStartedAt = now(); await save(); }
      const made = parseBaseline(await run(hostId, root, baselineCommand(resume), 600));
      if (!made.ok) return fail("baseline", made.code, made.detail, made.blocked);
      rec.baseline = { commit: made.commit, files: made.files, reused: made.reused, at: now() };
      await save();
    }

    const auth = await run(hostId, root, "gh auth status --hostname github.com");
    if (auth.exitCode === 127) return fail("auth", "no_provider_cli", "gh is not installed on this host");
    if (auth.exitCode !== 0) return fail("auth", "no_provider_auth", clip(auth.stderr || auth.stdout) || "gh is not signed in to github.com on this host");

    let owner = rec.repo?.owner;
    if (!owner) {
      const user = await run(hostId, root, "gh api user");
      try { owner = (JSON.parse(user.stdout) as { login?: string }).login; } catch { owner = undefined; }
      if (!owner || !/^[A-Za-z0-9-]+$/.test(owner)) return fail("auth", "no_provider_identity", clip(user.stderr) || "gh did not name the signed-in account");
    }
    const name = rec.repo?.name ?? repoNameFor(root);
    if (!name) return fail("repo", "no_repo_name", `no repository name can be made from ${root}`);
    rec.repo = { ...rec.repo, owner, name };

    const readback = async (): Promise<{ kind: "found"; raw: unknown } | { kind: "absent" } | { kind: "error"; detail: string }> => {
      const ran = await run(hostId, root, `gh api ${q(`repos/${owner}/${name}`)}`);
      if (ran.exitCode === 0) { try { return { kind: "found", raw: JSON.parse(ran.stdout) }; } catch { return { kind: "error", detail: "readback is not JSON" }; } }
      return /\(HTTP 404\)/.test(ran.stderr) ? { kind: "absent" } : { kind: "error", detail: clip(ran.stderr) || `exit ${ran.exitCode}` };
    };
    let seen = await readback();
    if (seen.kind === "error") return fail("repo", "readback_failed", seen.detail);
    if (seen.kind === "found" && rec.repo.id === undefined) {
      const createdAt = Date.parse((seen.raw as { created_at?: string }).created_at ?? "");
      // Found before this bootstrap asked for it, or made long before: someone else's repository, never adopted.
      if (!rec.repo.requestedAt || !(createdAt >= rec.repo.requestedAt - 5 * 60_000)) return fail("repo", "remote_name_taken", `${owner}/${name} already exists and was not created by this bootstrap`);
    }
    if (seen.kind === "absent") {
      if (rec.repo.id !== undefined) return fail("repo", "repo_missing", `${owner}/${name} was created and verified before but is gone`);
      rec.repo.requestedAt = now();
      await save();
      const made = await run(hostId, root, `gh repo create ${q(`${owner}/${name}`)} --private --description ${q("Private repository made by Lane Pilot")}`, 120);
      seen = await readback();
      if (seen.kind === "absent") return fail("repo", "create_failed", clip(made.stderr || made.stdout) || `exit ${made.exitCode}`);
      if (seen.kind === "error") return fail("repo", "readback_failed", seen.detail);
    }
    const verified = verifyReadback(seen.raw, { owner, name, ...(rec.repo.id !== undefined ? { id: rec.repo.id } : {}) });
    if (!verified.ok) return fail("repo", "readback_mismatch", verified.reason);
    rec.repo = { ...rec.repo, id: verified.repo.id, fullName: verified.repo.fullName, cloneUrl: verified.repo.cloneUrl, verifiedAt: now() };
    await save();
    const url = verified.repo.cloneUrl;

    if (!rec.origin) {
      const current = await git("remote get-url origin");
      if (current.exitCode === 0 && current.stdout.trim()) {
        if (!sameRemote(current.stdout.trim(), url)) return fail("origin", "origin_conflict", `origin is ${current.stdout.trim()}; it is never overwritten`);
      } else if (current.exitCode === 2 || /no such remote/i.test(current.stderr)) {
        const added = await git(`remote add origin ${q(url)}`);
        if (added.exitCode !== 0) return fail("origin", "origin_failed", clip(added.stderr));
      } else return fail("origin", "origin_unreadable", clip(current.stderr) || `exit ${current.exitCode}`);
      rec.origin = { url, at: now() };
      await save();
    }

    const branch = (await git("symbolic-ref --short HEAD")).stdout.trim();
    const sha = (await git("rev-parse HEAD")).stdout.trim();
    if (!branch || !/^[0-9a-f]{40,64}$/.test(sha)) return fail("push", "no_head", "the repository has no branch or commit to push");
    if (rec.push?.sha !== sha) {
      const pushed = await run(hostId, root, `${GH_GIT} push -u origin ${q(`HEAD:refs/heads/${branch}`)}`, 600);
      if (pushed.exitCode !== 0) return fail("push", "push_failed", clip(pushed.stderr) || `exit ${pushed.exitCode}`);
      const remote = await run(hostId, root, `${GH_GIT} ls-remote origin ${q(`refs/heads/${branch}`)}`);
      if (remote.stdout.trim().split(/\s+/)[0] !== sha) return fail("push", "push_unverified", `origin ${branch} does not point at ${sha}`);
      rec.push = { branch, sha, at: now() };
      await save();
    }

    if (!rec.invalidated) {
      if (deps.invalidate) {
        try { await deps.invalidate({ hostId, root, url }); } catch (cause) { return fail("invalidate", "invalidate_failed", cause instanceof Error ? cause.message : String(cause)); }
        rec.invalidated = { at: now() };
      } else rec.invalidated = { at: now(), skipped: true };
    }
    rec.doneAt = now();
    delete rec.lastError;
    await save();
    return { ok: true, root, fullName: rec.repo.fullName!, url, commit: rec.baseline.commit, branch };
  }

  /**
   * The handler for a task's preflight: a folder in a repository goes on as it is (a parent repository is reused); a
   * folder without Git gets the scope question once and, on a pick, the bootstrap. `localNoOrigin` is reported, not
   * pushed anywhere: publishing an existing local repository is the caller's own decision (`bootstrap` does it).
   */
  async function ensure(input: ScopeInput): Promise<EnsureResult> {
    const scope = await resolveScope(input);
    if (scope.kind !== "chosen") return scope;
    return { kind: "bootstrapped", result: await bootstrap({ hostId: input.hostId, root: scope.choice.root }) };
  }

  return { probe, resolveScope, bootstrap, ensure };
}

export type ProjectGit = ReturnType<typeof createProjectGit>;
