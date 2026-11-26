import { createHash } from "node:crypto";
import { bestEffort } from "@lane-pilot/kit";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { isOpenAttemptState } from "../../../contracts";
import { configuredSetting, type ServerCore } from "../../../contracts/server";
import { closeOwnerItem, closeOwnerItemsByPrefix, hasOpenOwnerItem, listOpenOwnerItemKeys, postOwnerItem, rpcLine } from "../../../owner-waiting";
import { listQaHosts } from "../../../platform/server";
import { listOpenWorktrees, loadProjectSettings, recentAttemptWorkspaces, recentRunWorkspaces, recordJanitorSweep, releaseWorktree, releaseWorktreesUnder } from "../../../storage";
import { REPORTED_KEEP_REASONS, SEARCH_DEFAULTS, type BbEnvironment } from "../../../worktree";
import { CLEANUP_ITEM_PREFIX, OUTSIDE_ITEM_PREFIX, TEARDOWN_WAIT_MS, WORKTREE_YOUNG_MS, gb, type CleanupPassOutcome, type HubDecision, type JanitorOutcome } from "../../models/worktree-cleanup";
import { CLEANUP_WORKTREES_KEY, CLEANUP_WORKTREE_MAX_AGE_DAYS_KEY } from "../../settings";
import { ensureLegacyWorktreesAdopted, protectedWorktreePaths, reconcileWorktreeRegistry, runHourlyWorktreePass, worktreeGraceMs, type AttemptSweeps } from "./worktree-janitor";

/**
 * The daily worktree pass from the hub (docs/worktrees.md §3), the graph step lp.worktree_cleanup that runs both passes, and
 * `bb lane-pilot worktree-cleanup`. The hourly pass and the registry stay in worktree-janitor.ts; the machine's part is
 * verification/worktree-sweep.ts.
 */

/** cleanup.worktree_max_age_days in milliseconds (default 7 days, at least one). */
export function worktreeMaxAgeMs(db: ServerCore["db"]): number {
  const raw = configuredSetting(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID), CLEANUP_WORKTREE_MAX_AGE_DAYS_KEY);
  const days = typeof raw === "number" ? raw : Number(raw);
  return Math.max(1, Number.isFinite(days) && days > 0 ? days : 7) * 86_400_000;
}

/** A host that refused the daily pass's input: an older build whose contract has no `deep` (zod's strict-object refusal, or BB's input check). */
const OLDER_HOST = /unrecognized key|invalid[_ ]input|input validation/i;
const NO_DAILY_PASS = "this machine's Lane Pilot host is older and has no daily pass (update the plugin there)";

type DeepReceipt = NonNullable<Awaited<ReturnType<typeof import("../../../worktree").sweepWorktreeClasses>>>;
type HostAnswer = JanitorOutcome & { deep?: DeepReceipt };

/**
 * What the hub knows about each machine for the daily pass: the project folders (BB's project sources, Lane Pilot's run folders), the BB
 * environment worktrees of Lane Pilot attempts, the worktrees of abandoned tasks, the registry's open rows. «Abandoned» is a path every
 * attempt of which has ended without being accepted — cancelled, or failed and followed by a later attempt of the task, or left in a run
 * that is closed — and was last touched more than a day ago.
 */
export async function dailyPassInputs(ctx: Pick<ServerCore, "bb" | "db">, now = Date.now()): Promise<{
  folders: Map<string, Set<string>>; bbEnvPaths: Map<string, Set<string>>; abandoned: Map<string, Set<string>>; registry: Map<string, string[]>; candidates: string[];
}> {
  const { bb, db } = ctx;
  const add = (map: Map<string, Set<string>>, host: string, path: string) => { if (host && path?.startsWith("/")) map.set(host, (map.get(host) ?? new Set()).add(path)); };
  const folders = new Map<string, Set<string>>(), bbEnvPaths = new Map<string, Set<string>>(), abandoned = new Map<string, Set<string>>();
  // A list that throws before it returns a promise is the same unknown as one that rejects: the run folders below still give the folders.
  const sdkProjects = (bb.sdk as unknown as { projects?: { list(query: unknown): Promise<Array<{ sources?: Array<{ hostId?: string; path?: string }> }>> } }).projects;
  const projects = await Promise.resolve().then(() => sdkProjects?.list({ includePersonal: true }) ?? []).catch(() => []);
  for (const project of projects) for (const source of project.sources ?? []) add(folders, source.hostId ?? "", source.path ?? "");
  const runs = recentRunWorkspaces(db, now - 90 * 86_400_000);
  const runFolders = new Set<string>();
  for (const run of runs) { add(folders, run.host, run.path); runFolders.add(`${run.host}\0${run.path}`); }
  const attempts = recentAttemptWorkspaces(db, now - 90 * 86_400_000);
  const byPath = new Map<string, typeof attempts>();
  for (const row of attempts) {
    const key = `${row.host}\0${row.path}`;
    byPath.set(key, [...(byPath.get(key) ?? []), row]);
    // A BB environment of an attempt: not Lane Pilot's own root (that class is `lane`), never a run's own folder or environment.
    if (row.env && row.env !== row.runEnv && !row.path.includes("/.lane-pilot/worktrees/") && !runFolders.has(key)) add(bbEnvPaths, row.host, row.path);
  }
  for (const [key, rows] of byPath) {
    if (runFolders.has(key)) continue;
    const ended = rows.every((row) => !isOpenAttemptState(row.state) && row.state !== "accepted");
    const given = rows.some((row) => row.state === "canceled" || row.runClosed !== null || row.later > 0);
    if (ended && given && Math.max(...rows.map((row) => row.updatedAt)) < now - WORKTREE_YOUNG_MS) add(abandoned, rows[0]!.host, rows[0]!.path);
  }
  const registry = new Map<string, string[]>();
  for (const row of listOpenWorktrees(db)) if (row.created_at < now - 3_600_000) registry.set(row.host, [...(registry.get(row.host) ?? []), row.path]);
  const candidates: string[] = [];
  return { folders, bbEnvPaths, abandoned, registry, candidates };
}

/** The bounded home search the daily pass asks each machine for (docs/worktrees.md): its home, 5 levels down, at most 2000 repositories or 3 minutes. */
export const WORKTREE_SEARCH = { maxDepth: SEARCH_DEFAULTS.maxDepth, maxRepos: SEARCH_DEFAULTS.maxRepos, budgetMs: SEARCH_DEFAULTS.budgetMs } as const;

type SdkEnvironment = { id: string; hostId: string; path: string | null; managed: boolean; isWorktree: boolean; status: string };
type SdkThread = { environmentId: string | null };

/**
 * The BB environments with a folder, by machine: `managed` when BB's provider made it as a worktree (BB removes it, through `environments.delete`),
 * `live` when a thread that is neither archived nor deleted is in it (BB's own rule: delete refuses then). A list BB refuses gives no environment
 * at all and the reason: then no environment is removed through BB, and none is known to be live.
 */
export async function bbEnvironmentsByHost(bb: ServerCore["bb"]): Promise<{ byHost: Map<string, BbEnvironment[]>; error: string | null }> {
  const sdk = bb.sdk as unknown as {
    environments?: { list(args: { limit: number; offset: number }): Promise<SdkEnvironment[]> };
    threads?: { list(args: { archived: false; includeHidden: true; limit: number; offset: number }): Promise<SdkThread[]> };
  };
  const byHost = new Map<string, BbEnvironment[]>();
  const page = 500;
  try {
    if (!sdk.environments?.list || !sdk.threads?.list) return { byHost, error: "this BB offers no environments.list or threads.list" };
    const envs: SdkEnvironment[] = [];
    for (let offset = 0; offset < 50_000; offset += page) { const rows = await sdk.environments.list({ limit: page, offset }); envs.push(...rows); if (rows.length < page) break; }
    const live = new Set<string>();
    for (let offset = 0; offset < 200_000; offset += page) {
      const rows = await sdk.threads.list({ archived: false, includeHidden: true, limit: page, offset });
      for (const row of rows) if (row.environmentId) live.add(row.environmentId);
      if (rows.length < page) break;
    }
    for (const env of envs) {
      if (!env.path?.startsWith("/") || env.status === "destroyed") continue;
      byHost.set(env.hostId, [...(byHost.get(env.hostId) ?? []), { path: env.path, environmentId: env.id, managed: env.managed && env.isWorktree, live: live.has(env.id) }]);
    }
    return { byHost, error: null };
  } catch (cause) {
    return { byHost: new Map(), error: `BB environments unread: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}` };
  }
}

/**
 * The daily pass on every connected machine (docs/worktrees.md, SMA dt_wt_sweep): the hourly sweep plus every class in the project
 * repositories, `git worktree prune`, the registry rows whose folder is gone closed. One janitor row per machine (pass daily, with
 * kept_unmerged and the report by class) and one owner line for what a person has to look at — the copies kept for unmerged commits,
 * uncommitted changes or a live lock — posted once per distinct list, never once per pass.
 */
export async function runDailyWorktreePass(ctx: Pick<ServerCore, "bb" | "db" | "log" | "isDisposed" | "host">, now = Date.now(), options: { dryRun?: boolean; teardownWaitMs?: number } = {}): Promise<CleanupPassOutcome> {
  const { bb, db } = ctx;
  const settings = loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID);
  if (configuredSetting(settings, CLEANUP_WORKTREES_KEY) === "off") return { status: "off", removed: 0, freedBytes: 0, kept: 0, hourlyRemoved: [], hourlyTmpRemoved: [], report: "cleanup.worktrees=off" };
  const dryRun = options.dryRun === true;
  await ensureLegacyWorktreesAdopted(ctx);
  if (!dryRun) await bestEffort(ctx.log, "worktree registry reconcile", reconcileWorktreeRegistry(ctx, now), 0);
  const inputs = await dailyPassInputs(ctx, now);
  const protectedPaths = [...await protectedWorktreePaths(ctx, now), ...inputs.candidates];
  const maxAgeMs = worktreeMaxAgeMs(db);
  const hosts = (await listQaHosts(bb)).filter((row) => row.connected);
  const environments = await bbEnvironmentsByHost(bb);
  let removed = 0, freedBytes = 0, kept = 0, keptUnmergedAll = 0, pruned = 0, closed = 0;
  const attention: Array<{ host: string; path: string; reason: string; detail: string; bytes: number }> = [];
  const outside: Array<{ host: string; path: string; reason: string; detail: string; bytes: number }> = [];
  const decisions: HubDecision[] = [];
  const searches: NonNullable<CleanupPassOutcome["search"]> = [];
  const hourlyRemoved: Array<{ host: string; path: string }> = [];
  const hourlyTmpRemoved: Array<{ host: string; path: string }> = [];
  const branchesKept: string[] = [];
  const errors: string[] = environments.error ? [environments.error] : [];
  const notes: string[] = [];
  for (const machine of hosts) {
    if (ctx.isDisposed()) break;
    const name = machine.name ?? machine.id;
    const legacyDeep = { folders: [...inputs.folders.get(machine.id) ?? []], bbEnvPaths: [...inputs.bbEnvPaths.get(machine.id) ?? []], abandonedPaths: [...inputs.abandoned.get(machine.id) ?? []],
      registryPaths: inputs.registry.get(machine.id) ?? [], maxAgeMs, youngMs: WORKTREE_YOUNG_MS, now: Math.round(now), ...(dryRun ? { dryRun: true, hourlyGraceMs: worktreeGraceMs(db) } : {}) };
    const { hourlyGraceMs: _hourlyGraceMs, ...legacyDeepForOldHost } = legacyDeep;
    const call = (deep: Record<string, unknown>) => ctx.host.call("worktreeJanitor", {
      // Keep the top-level grace endless for old strict hosts; current hosts get the normal hourly grace through deep.hourlyGraceMs.
      requestedHostId: machine.id, protectedPaths, graceMs: dryRun ? Number.MAX_SAFE_INTEGER : worktreeGraceMs(db), deep,
    } as never, { hostId: machine.id, timeoutMs: 30 * 60_000 }) as Promise<HostAnswer>;
    const textOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
    let out: HostAnswer;
    try {
      out = await call({ ...legacyDeep, bbEnvs: environments.byHost.get(machine.id) ?? [], search: WORKTREE_SEARCH });
    } catch (cause) {
      const text = textOf(cause);
      if (!OLDER_HOST.test(text)) { errors.push(`${name}: ${text}`); continue; }
      // A machine on 0.1.562–0.1.564 checks its input against its own strict contract and refuses the keys of 0.1.565 (`bbEnvs`, `search`):
      // it is asked once more for the daily pass it knows, without them and without the BB environment paths (no BB environment is removed
      // except by BB). A machine before 0.1.562 refuses `deep` itself: nothing is removed there, its hourly sweep keeps running.
      try {
        out = await call({ ...legacyDeepForOldHost, bbEnvPaths: [] });
        notes.push(`${name}: ran the old daily pass (no home search, no BB-environment decisions): its Lane Pilot build is older (update the plugin there)`);
      } catch (again) {
        const second = textOf(again);
        errors.push(`${name}: ${OLDER_HOST.test(second) ? `${NO_DAILY_PASS}; nothing was removed on it (${second.slice(0, 160)})` : second}`);
        continue;
      }
    }
    const deep = out.deep;
    if (!deep) {
      // A host that took the call but ignored `deep` ran its hourly sweep only: its removals are real, their registry rows close.
      for (const path of out.removed ?? []) hourlyRemoved.push({ host: name, path });
      for (const path of out.tmpRemoved ?? []) hourlyTmpRemoved.push({ host: name, path });
      if (!dryRun) for (const path of out.removed ?? []) closed += releaseWorktreesUnder(db, machine.id, path, now);
      removed += out.removed?.length ?? 0;
      errors.push(`${machine.name ?? machine.id}: ${NO_DAILY_PASS}; only its hourly sweep ran`);
      continue;
    }
    const host = machine.name ?? machine.id;
    const hostHourlyRemoved = (out.removed ?? []).map((path) => ({ host, path }));
    const hostHourlyTmpRemoved = (out.tmpRemoved ?? []).map((path) => ({ host, path }));
    hourlyRemoved.push(...hostHourlyRemoved);
    hourlyTmpRemoved.push(...hostHourlyTmpRemoved);
    if (deep.search) searches.push({ host, ...deep.search });
    // A BB environment the machine found merged, clean and old: BB removes it (its provider runs `git worktree remove`), never this pass by
    // hand. BB refuses while a thread that is not archived is in it; then it is kept with BB's answer.
    let envFreed = 0;
    const firstDecision = decisions.length;
    const asked: typeof deep.decisions = [];
    for (const row of deep.decisions ?? []) {
      if (row.decision === "remove" && row.via === "bb" && row.environmentId) {
        if (!dryRun) {
          const environmentId = row.environmentId;
          const refused = await Promise.resolve().then(() => bb.sdk.environments.delete({ environmentId }))
            .then(() => null, (cause: unknown) => cause instanceof Error ? cause.message : String(cause));
          if (refused) {
            const detail = `BB refused to remove the environment: ${refused.slice(0, 200)}`;
            deep.kept.push({ path: row.path, cls: "bb-env", reason: "error", detail, bytes: row.bytes, ageMs: row.ageMs ?? 0, branch: row.branch });
            decisions.push({ ...row, decision: "keep", reason: "error", detail, host } as HubDecision);
            continue;
          }
          // BB tears an environment down in the background: counted only once BB says it is gone (below).
          asked!.push(row);
          continue;
        }
        envFreed += row.bytes;
        deep.removed.push({ path: row.path, cls: "bb-env", bytes: row.bytes, branch: row.branch, branchDeleted: false, why: "merged", how: row.merged });
      }
      if (row.decision === "skip") outside.push({ host, path: row.path, reason: row.reason, detail: row.detail, bytes: row.bytes });
      decisions.push({ ...row, host } as HubDecision);
    }
    if (asked?.length) {
      const states = await awaitTeardown(bb, asked.map((row) => row.environmentId!), options.teardownWaitMs ?? TEARDOWN_WAIT_MS);
      for (const row of asked) {
        const state = states.get(row.environmentId!) ?? "unread";
        if (state === "gone") {
          envFreed += row.bytes;
          deep.removed.push({ path: row.path, cls: "bb-env", bytes: row.bytes, branch: row.branch, branchDeleted: false, why: "merged", how: row.merged });
          decisions.push({ ...row, host, outcome: "removed", detail: row.detail.replace(/: BB removes the environment$/u, ": BB removed the environment") } as HubDecision);
        } else {
          decisions.push({ ...row, host, outcome: "asked",
            detail: row.detail.replace(/: BB removes the environment$/u, `: asked BB to remove the environment (BB: ${state}); the next pass sees whether its folder is gone`) } as HubDecision);
        }
      }
    }
    deep.freedBytes += envFreed;
    // In a dry pass the hourly sweep reports its candidates without removing them, so the deep
    // search can see an old Lane copy again. Count/report that path once; actual deep runs cannot
    // see a copy already removed by hourly, but the same guard keeps host receipts honest.
    const hourlyPaths = new Set(out.removed ?? []);
    const deepRemoved = deep.removed.filter((row) => !hourlyPaths.has(row.path));
    const duplicateFreed = deep.removed.reduce((sum, row) => sum + (hourlyPaths.has(row.path) ? row.bytes : 0), 0);
    const deepFreedBytes = Math.max(0, deep.freedBytes - duplicateFreed);
    if (!dryRun) {
      for (const row of deepRemoved) closed += releaseWorktreesUnder(db, machine.id, row.path, now);
      for (const path of out.removed ?? []) closed += releaseWorktreesUnder(db, machine.id, path, now);
      for (const path of deep.registryGone) { const before = closed; closed += releaseWorktreesUnder(db, machine.id, path, now); if (closed === before) releaseWorktree(db, machine.id, path, now); }
    }
    const reported = deep.kept.filter((row) => (REPORTED_KEEP_REASONS as readonly string[]).includes(row.reason));
    const keptUnmerged = deep.kept.filter((row) => row.reason === "unmerged").length;
    const byClass: Record<string, { removed: number; freedBytes: number; kept: Record<string, number> }> = {};
    for (const row of deepRemoved) { const entry = byClass[row.cls] ??= { removed: 0, freedBytes: 0, kept: {} }; entry.removed += 1; entry.freedBytes += row.bytes; }
    for (const row of deep.kept) { const entry = byClass[row.cls] ??= { removed: 0, freedBytes: 0, kept: {} }; entry.kept[row.reason] = (entry.kept[row.reason] ?? 0) + 1; }
    for (const row of deep.decisions ?? []) if (row.decision === "skip") { const entry = byClass.outside ??= { removed: 0, freedBytes: 0, kept: {} }; entry.kept[row.reason] = (entry.kept[row.reason] ?? 0) + 1; }
    const hostRemoved = deepRemoved.length + (out.removed?.length ?? 0);
    const hostFreed = deepFreedBytes + (out.freedBytes ?? 0) + (out.tmpFreedBytes ?? 0);
    removed += hostRemoved; freedBytes += hostFreed; kept += reported.length + (out.kept?.length ?? 0); keptUnmergedAll += keptUnmerged; pruned += deep.pruned;
    for (const row of reported) attention.push({ host: machine.name ?? machine.id, path: row.path, reason: row.reason, detail: row.detail, bytes: row.bytes });
    for (const row of deep.branchesKept) branchesKept.push(`${machine.name ?? machine.id}: ${row.branch} (${row.repo}) — ${row.reason}`);
    for (const error of [...deep.errors, ...(out.errors ?? [])]) errors.push(`${machine.name ?? machine.id}: ${error}`);
    if (!dryRun) recordJanitorSweep(db, {
      at: now, host: machine.id, pass: "daily", removed: hostRemoved, freedBytes: Math.round(deepFreedBytes + (out.freedBytes ?? 0)), tmpRemoved: out.tmpRemoved?.length ?? 0, tmpFreedBytes: Math.round(out.tmpFreedBytes ?? 0),
      keptJson: JSON.stringify(reported.slice(0, 50).map((row) => `${row.path} (${row.reason}: ${row.detail})`)), keptUnmerged,
      reportJson: JSON.stringify({ classes: byClass, pruned: deep.pruned, registryClosed: deep.registryGone.length, repos: deep.repos, branchesKept: deep.branchesKept.slice(0, 50),
        removed: deepRemoved.slice(0, 100).map((row) => ({ path: row.path, cls: row.cls, bytes: row.bytes, branch: row.branch, branchDeleted: row.branchDeleted, why: row.why, how: row.how })), errors: deep.errors.slice(0, 20),
        hourlyRemoved: hostHourlyRemoved.slice(0, 2000), hourlyTmpRemoved: hostHourlyTmpRemoved.slice(0, 2000),
        search: deep.search ?? null, oldPass: notes.some((line) => line.startsWith(`${name}: `)),
        decisions: decisions.slice(firstDecision, firstDecision + 1000).map((row) => ({ path: row.path, cls: row.cls, decision: row.decision, reason: row.reason, detail: row.detail, ...(row.outcome ? { outcome: row.outcome } : {}) })) }),
    });
  }
  const reasonWord: Record<string, string> = { unmerged: "невлитые коммиты", dirty: "незакоммиченные правки", locked: "заблокирована живым процессом", error: "не прочиталась" };
  const counts = Object.entries(attention.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.reason]: (acc[row.reason] ?? 0) + 1 }), {})).map(([reason, count]) => `${reasonWord[reason] ?? reason} ${count}`).join(", ");
  const report = `${dryRun ? "Пробный проход (ничего не удалено): было бы удалено" : "Удалено"} ${removed} worktree, освобождено ${gb(freedBytes)}; prune ${pruned}, закрыто строк реестра ${closed}; оставлено на проверку ${attention.length}${counts ? ` (${counts})` : ""}${outside.length ? `; вне управляемых классов (только список) ${outside.length}` : ""}${branchesKept.length ? `; ветки с невлитыми коммитами оставлены: ${branchesKept.length}` : ""}${errors.length ? `; ошибки: ${errors.length}` : ""}`;
  if (!dryRun) {
    postCleanupItem(db, attention, report, branchesKept, now);
    postOutsideItem(db, outside, now);
  }
  if (errors.length) ctx.log(`Lane Pilot daily worktree pass: ${errors.slice(0, 5).join("; ")}`);
  // The removals are named first (a dry run must say what it would remove, not only what it keeps); the full list is in `decisions`.
  const hourlyRemovalKeys = new Set(hourlyRemoved.map((row) => `${row.host}\0${row.path}`));
  const removals = decisions.filter((row) => row.decision === "remove" && !hourlyRemovalKeys.has(`${row.host}\0${row.path}`));
  // The status counts the machines that failed; an unread environment list is reported, but it fails no pass on its own.
  const machineErrors = errors.length - (environments.error ? 1 : 0);
  return { status: hosts.length && machineErrors >= hosts.length && !removed ? "error" : "ok", removed, freedBytes, kept, decisions, search: searches,
    hourlyRemoved, hourlyTmpRemoved,
    report: [report,
      ...notes.map((line) => `- ${line}`),
      ...hourlyRemoved.slice(0, 30).map((row) => `- ${dryRun ? "удалилось бы" : "удалено"}: ${row.host}: ${row.path} — hourly sweep`),
      ...(hourlyRemoved.length > 30 ? [`- … и ещё ${hourlyRemoved.length - 30} hourly removals (полный список: ${dryRun ? "--json" : "запись daily report_json"})`] : []),
      ...hourlyTmpRemoved.slice(0, 10).map((row) => `- ${dryRun ? "удалилось бы" : "удалено"}: ${row.host}: ${row.path} — hourly tmp sweep`),
      ...removals.slice(0, 30).map((row) => `- ${dryRun ? "удалилось бы" : row.outcome === "asked" ? "попросили BB удалить" : "удалено"}: ${row.host}: ${row.path} — ${row.detail}`),
      ...(removals.length > 30 ? [`- … и ещё ${removals.length - 30} (полный список: --json, decisions)`] : []),
      ...attention.slice(0, 20).map((row) => `- ${row.host}: ${row.path} — ${reasonWord[row.reason] ?? row.reason}: ${row.detail}`),
      ...outside.slice(0, 10).map((row) => `- вне классов: ${row.host}: ${row.path} — ${row.detail}`),
      ...branchesKept.slice(0, 10).map((line) => `- ${line}`), ...errors.slice(0, 10).map((line) => `- ошибка: ${line}`)].join("\n") };
}

/**
 * BB removes an environment in the background (`environments.delete` only asks its provider). Re-read each one through `environments.get`
 * until `waitMs` is spent: «gone» when BB says it is destroyed, its teardown removed, or it is no longer known; else BB's state as read.
 */
async function awaitTeardown(bb: ServerCore["bb"], ids: string[], waitMs: number): Promise<Map<string, string>> {
  const sdk = bb.sdk as unknown as { environments?: { get?(args: { environmentId: string }): Promise<{ status?: string; lifecycle?: { phase?: string; teardown?: { status?: string; message?: string } | null } }> } };
  const states = new Map<string, string>();
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    for (const id of ids) {
      if (states.get(id) === "gone") continue;
      if (!sdk.environments?.get) { states.set(id, "unread: this BB offers no environments.get"); continue; }
      const read = await Promise.resolve().then(() => sdk.environments!.get!({ environmentId: id })).then(
        (env) => env.status === "destroyed" || env.lifecycle?.teardown?.status === "removed" ? "gone"
          : `${env.status ?? "?"}${env.lifecycle?.teardown ? `, teardown ${env.lifecycle.teardown.status}${env.lifecycle.teardown.message ? `: ${env.lifecycle.teardown.message.slice(0, 120)}` : ""}` : ""}`,
        (cause: unknown) => /not[ _]found|404/iu.test(cause instanceof Error ? cause.message : String(cause)) ? "gone" : `unread: ${String(cause instanceof Error ? cause.message : cause).slice(0, 120)}`);
      states.set(id, read);
    }
    if (ids.every((id) => states.get(id) === "gone") || Date.now() >= deadline) return states;
    await new Promise((wake) => setTimeout(wake, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
}

function postOutsideItem(db: ServerCore["db"], outside: Array<{ host: string; path: string; reason: string; detail: string; bytes: number }>, now: number): void {
  try {
    const lines = outside.map((row) => `${row.host}\t${row.path}\t${row.reason}`).sort();
    if (!lines.length) { closeOwnerItemsByPrefix(db, OUTSIDE_ITEM_PREFIX, "janitor:worktree-cleanup", now); return; }
    const key = `${OUTSIDE_ITEM_PREFIX}${createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16)}`;
    if (hasOpenOwnerItem(db, { key })) return;
    for (const open of listOpenOwnerItemKeys(db, { source: "janitor", kind: "worktree_cleanup" }).filter((item) => item.startsWith(OUTSIDE_ITEM_PREFIX) && item !== key)) closeOwnerItem(db, open, "janitor:worktree-cleanup", now);
    const read = { id: "read", label: "Прочитано", cli: rpcLine("owner_waiting_close", { key }), rpc: { method: "owner_waiting_close", input: { key } } };
    const size = outside.reduce((sum, row) => sum + row.bytes, 0);
    postOwnerItem(db, { key, source: "janitor", kind: "worktree_cleanup", reason: "decision", projectId: null, wake: false, actions: [read],
      what: `Worktree вне классов Lane Pilot: ${outside.length} копий (${gb(size)}), уборка их не трогает`,
      why: ["Это копии вне .worktrees, .claude/worktrees, .git/lp-phases и корня Lane Pilot (релизные, ручные). Влита и стара — ещё не повод удалять: копия может быть в работе.",
        ...outside.slice(0, 12).map((row) => `${row.host}: ${row.path} — ${row.detail}`)].join("\n"),
      evidence: [{ kind: "text", ref: "lane_pilot_janitor", label: "строки ежедневного прохода" }] }, now);
  } catch { /* the janitor rows and the run output have it */ }
}

/**
 * One owner line for the copies a person has to look at, keyed by the list itself: the same list tomorrow is the same open line (nothing
 * new on his screen), a changed list closes the old line and opens a new one, an empty list closes it. A line the owner closed himself
 * stays closed while the list is the same (postOwnerItem keeps his answer).
 */
function postCleanupItem(db: ServerCore["db"], attention: Array<{ host: string; path: string; reason: string; detail: string; bytes: number }>, report: string, branchesKept: string[], now: number): void {
  try {
    const lines = attention.map((row) => `${row.host}\t${row.path}\t${row.reason}`).sort();
    if (!lines.length) { closeOwnerItemsByPrefix(db, CLEANUP_ITEM_PREFIX, "janitor:worktree-cleanup", now); return; }
    const key = `${CLEANUP_ITEM_PREFIX}${createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16)}`;
    if (hasOpenOwnerItem(db, { key })) return;
    for (const open of listOpenOwnerItemKeys(db, { source: "janitor", kind: "worktree_cleanup" }).filter((item) => item.startsWith(CLEANUP_ITEM_PREFIX) && item !== key)) closeOwnerItem(db, open, "janitor:worktree-cleanup", now);
    const read = { id: "read", label: "Прочитано", cli: rpcLine("owner_waiting_close", { key }), rpc: { method: "owner_waiting_close", input: { key } } };
    postOwnerItem(db, { key, source: "janitor", kind: "worktree_cleanup", reason: "decision", projectId: null, wake: false, actions: [read],
      what: `Уборка worktree: ${attention.length} копий оставлены, их нужно разобрать вручную`,
      why: [report, ...attention.slice(0, 8).map((row) => `${row.host}: ${row.path} — ${row.detail}`), ...branchesKept.slice(0, 4)].join("\n"),
      evidence: [{ kind: "text", ref: "lane_pilot_janitor", label: "строки ежедневного прохода" }] }, now);
  } catch { /* the janitor rows and the run output have it */ }
}

/**
 * One cleanup pass, as the graph's step and `bb lane-pilot worktree-cleanup` run it. A dry run is always the daily pass's: it decides for every
 * class, Lane Pilot's root included, and removes nothing; the hourly candidates are read with the current host's normal grace while
 * the top-level grace remains infinite for old strict hosts.
 * A pass that throws ends `error` with the reason.
 */
export async function runWorktreeCleanupPass(ctx: Pick<ServerCore, "bb" | "db" | "log" | "isDisposed" | "host">, sweeps: AttemptSweeps, input: { pass: "hourly" | "daily"; dryRun?: boolean }, now = Date.now()): Promise<CleanupPassOutcome & { pass: "hourly" | "daily"; dryRun: boolean }> {
  const dryRun = input.dryRun === true;
  const pass = dryRun ? "daily" : input.pass;
  try {
    const out = pass === "daily" ? await runDailyWorktreePass(ctx, now, { dryRun }) : await runHourlyWorktreePass(ctx, sweeps, now);
    return { ...out, pass, dryRun };
  } catch (cause) {
    return { status: "error", removed: 0, freedBytes: 0, kept: 0, hourlyRemoved: [], hourlyTmpRemoved: [], report: `the ${pass} pass stopped: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 2000), pass, dryRun };
  }
}
