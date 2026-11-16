import { randomUUID } from "node:crypto";
import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import type { OwnerAsk } from "../../relay/server";
import {
  bootstrapKey, declinedKey, isWithin, ownsUncertainRepo, repoDescription, repoNameFor, sameRemote, scopeKey, scopeQuestion, verifyReadback,
  type BootstrapRecord, type BootstrapStage, type GitProbe, type SavedScope, type ScopeChoice,
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
  /** A repository exists: the work goes on in it. `localNoOrigin` is reported, never published: its history was not scanned. */
  | { kind: "repo"; state: "origin" | "localNoOrigin"; root: string }
  | { kind: "chosen"; choice: ScopeChoice; account: string }
  | { kind: "declined"; reason: string }
  | { kind: "unknown"; reason: string }
  /** gh is missing or not signed in to github.com on the host: nothing is asked, nothing is made. */
  | { kind: "noProvider"; code: string; reason: string }
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
/** Every gh call names github.com: a GH_HOST on the host never redirects it. */
const GH = "GH_HOST=github.com gh";
/** `gh` lends its own login to this one git call: no token is stored, no git config is changed. */
const GH_GIT = `git -c credential.helper= -c ${q("credential.helper=!gh auth git-credential")}`;
const clip = (text: string) => text.trim().slice(0, 300);

/**
 * Private Git for a folder without it: probe (P03.04), the one scope question naming the github.com account (P03.05),
 * the curated first commit (P03.06), a private repository through the host's own `gh` login with an authenticated
 * readback (P03.07), and a durable record of each stage so a retry continues where the last attempt stopped and a lost
 * answer never creates a second repository (P03.08). Only the recorded first commit is ever pushed; a repository with
 * history this operation did not make is refused. Everything runs on the folder's own host.
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

  /** The github.com account gh is signed in as on the host. */
  async function account(hostId: string, cwd: string): Promise<{ ok: true; login: string } | { ok: false; code: string; detail: string }> {
    const auth = await run(hostId, cwd, `${GH} auth status --hostname github.com`);
    if (auth.exitCode === 127) return { ok: false, code: "no_provider_cli", detail: "gh is not installed on this host" };
    if (auth.exitCode !== 0) return { ok: false, code: "no_provider_auth", detail: clip(auth.stderr || auth.stdout) || "gh is not signed in to github.com on this host" };
    const user = await run(hostId, cwd, `${GH} api --hostname github.com user`);
    let login: string | undefined;
    try { login = (JSON.parse(user.stdout) as { login?: string }).login; } catch { login = undefined; }
    return login && /^[A-Za-z0-9-]+$/.test(login) ? { ok: true, login } : { ok: false, code: "no_provider_identity", detail: clip(user.stderr) || "gh did not name the signed-in account" };
  }

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
    if (input.taskKey && await deps.kv.get<string>(declinedKey(input.taskKey))) return { kind: "declined", reason: "the owner declined Git for this task" };
    let pending = asking.get(key);
    if (!pending) {
      pending = (async (): Promise<ScopeResult> => {
        const signedIn = await account(input.hostId, target.cwd!);
        if (!signedIn.ok) return { kind: "noProvider", code: signedIn.code, reason: signedIn.detail };
        const saved = await deps.kv.get<SavedScope>(key);
        if (saved && saved.account === signedIn.login && candidates.some((c) => c.scope === saved.scope && c.root === saved.root)) {
          return { kind: "chosen", choice: { scope: saved.scope, root: saved.root }, account: saved.account };
        }
        return ask(input, candidates, key, signedIn.login);
      })().finally(() => asking.delete(key));
      asking.set(key, pending);
    }
    return pending;
  }

  async function ask(input: ScopeInput, candidates: ScopeChoice[], key: string, login: string): Promise<ScopeResult> {
    const form = scopeQuestion(candidates, input.locale ?? "ru", login);
    const answer = await deps.ownerAsk.ask(input.threadId, { source: "pm", kind: "decision", ...form },
      { ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    if (answer.outcome === "unavailable") return { kind: "unavailable", reason: answer.reason };
    const picked = answer.outcome === "answered" && answer.choice ? candidates[Number(answer.choice.id) - 1] : undefined;
    if (picked) {
      await deps.kv.set(key, { ...picked, account: login } satisfies SavedScope as never);
      return { kind: "chosen", choice: picked, account: login };
    }
    const reason = answer.outcome === "cancelled" ? answer.reason : `no scope picked: ${answer.text}`;
    if (input.taskKey && !(answer.outcome === "cancelled" && NOT_THE_OWNER.has(answer.reason))) await deps.kv.set(declinedKey(input.taskKey), reason as never);
    return { kind: "declined", reason };
  }

  /** `account`: the github.com login the owner was shown; another sign-in stops the bootstrap. */
  function bootstrap(input: { hostId: string; root: string; account: string }): Promise<BootstrapResult> {
    const key = bootstrapKey(input.hostId, input.root);
    let pending = running.get(key);
    if (!pending) {
      pending = stages(input.hostId, input.root, input.account, key).finally(() => running.delete(key));
      running.set(key, pending);
    }
    return pending;
  }

  async function stages(hostId: string, root: string, expectedAccount: string, key: string): Promise<BootstrapResult> {
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
      // Only a folder without Git, or the repository this operation started, gets a first commit; any other history is never published.
      if (found.state !== "noGit" && !rec.opId) return fail("baseline", "existing_history", "a repository Lane Pilot did not start: its history was never scanned and is not published");
      if (!rec.opId) { rec.opId = randomUUID(); rec.baselineStartedAt = now(); await save(); }
      const made = parseBaseline(await run(hostId, root, baselineCommand({ root, opId: rec.opId }), 600));
      if (!made.ok) return fail("baseline", made.code, made.detail, made.blocked);
      rec.baseline = { commit: made.commit, tree: made.tree, branch: made.branch, files: made.files, reused: made.reused, at: now() };
      await save();
    }
    const baseline = rec.baseline;
    // Nothing after the first commit is published: a commit or a branch switch since then stops the bootstrap.
    const drift = async (): Promise<string | null> => {
      const head = (await git("rev-parse HEAD")).stdout.trim();
      const branch = (await git("symbolic-ref --short HEAD")).stdout.trim();
      return head === baseline.commit && branch === baseline.branch ? null : `HEAD is ${head || "unreadable"} on ${branch || "no branch"}, the first commit was ${baseline.commit} on ${baseline.branch}`;
    };
    const moved = await drift();
    if (moved) return fail("baseline", "head_moved", moved);

    const signedIn = await account(hostId, root);
    if (!signedIn.ok) return fail("auth", signedIn.code, signedIn.detail);
    if (signedIn.login.toLowerCase() !== expectedAccount.toLowerCase()) return fail("auth", "account_changed", `gh is signed in as ${signedIn.login}, the owner was shown ${expectedAccount}`);
    const owner = rec.repo?.owner ?? signedIn.login;
    const name = rec.repo?.name ?? repoNameFor(root);
    if (!name) return fail("repo", "no_repo_name", `no repository name can be made from ${root}`);
    rec.repo = { ...rec.repo, owner, name };
    const opId = rec.opId!;

    const readback = async (): Promise<{ kind: "found"; raw: unknown } | { kind: "absent" } | { kind: "error"; detail: string }> => {
      const ran = await run(hostId, root, `${GH} api --hostname github.com ${q(`repos/${owner}/${name}`)}`);
      if (ran.exitCode === 0) { try { return { kind: "found", raw: JSON.parse(ran.stdout) }; } catch { return { kind: "error", detail: "readback is not JSON" }; } }
      return /\(HTTP 404\)/.test(ran.stderr) ? { kind: "absent" } : { kind: "error", detail: clip(ran.stderr) || `exit ${ran.exitCode}` };
    };
    let seen = await readback();
    if (seen.kind === "error") return fail("repo", "readback_failed", seen.detail);
    // Found before this operation confirmed its create: adopted only when it names this operation and is still empty.
    if (seen.kind === "found" && rec.repo.id === undefined && !(rec.repo.requestedAt && ownsUncertainRepo(seen.raw, opId))) {
      return fail("repo", "remote_name_taken", `${owner}/${name} already exists and is not this bootstrap's empty repository`);
    }
    if (seen.kind === "absent") {
      if (rec.repo.id !== undefined) return fail("repo", "repo_missing", `${owner}/${name} was created and verified before but is gone`);
      rec.repo.requestedAt ??= now();
      await save();
      const made = await run(hostId, root, `${GH} repo create ${q(`${owner}/${name}`)} --private --description ${q(repoDescription(opId))}`, 120);
      seen = await readback();
      if (seen.kind === "absent") return fail("repo", "create_failed", clip(made.stderr || made.stdout) || `exit ${made.exitCode}`);
      if (seen.kind === "error") return fail("repo", "readback_failed", seen.detail);
      if (rec.repo.id === undefined && !ownsUncertainRepo(seen.raw, opId)) return fail("repo", "remote_name_taken", `${owner}/${name} is not the empty repository this bootstrap asked for`);
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

    if (rec.push?.sha !== baseline.commit) {
      const late = await drift();
      if (late) return fail("push", "head_moved", late);
      // The recorded commit by its id, never whatever HEAD is by the time the push runs.
      const pushed = await run(hostId, root, `${GH_GIT} push origin ${q(`${baseline.commit}:refs/heads/${baseline.branch}`)}`, 600);
      if (pushed.exitCode !== 0) return fail("push", "push_failed", clip(pushed.stderr) || `exit ${pushed.exitCode}`);
      const remote = await run(hostId, root, `${GH_GIT} ls-remote origin ${q(`refs/heads/${baseline.branch}`)}`);
      if (remote.stdout.trim().split(/\s+/)[0] !== baseline.commit) return fail("push", "push_unverified", `origin ${baseline.branch} does not point at ${baseline.commit}`);
      await git(`branch --set-upstream-to=${q(`origin/${baseline.branch}`)} ${q(baseline.branch)}`);
      rec.push = { branch: baseline.branch, sha: baseline.commit, at: now() };
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
    return { ok: true, root, fullName: rec.repo.fullName!, url, commit: baseline.commit, branch: baseline.branch };
  }

  /**
   * The handler for a task's preflight: a folder in a repository goes on as it is (a parent repository is reused, an
   * existing local repository is reported and never published); a folder without Git gets the one scope question and,
   * on a pick, the bootstrap with the account the owner was shown.
   */
  async function ensure(input: ScopeInput): Promise<EnsureResult> {
    const scope = await resolveScope(input);
    if (scope.kind !== "chosen") return scope;
    return { kind: "bootstrapped", result: await bootstrap({ hostId: input.hostId, root: scope.choice.root, account: scope.account }) };
  }

  return { probe, resolveScope, bootstrap, ensure };
}

export type ProjectGit = ReturnType<typeof createProjectGit>;
