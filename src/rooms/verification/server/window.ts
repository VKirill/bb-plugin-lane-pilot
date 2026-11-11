import { ownsPathsOverlap } from "@lane-pilot/kit";
import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import { allGuests, CLAIMS_MAX, GUEST_TTL_MS, listGuests, saveGuests, withGuestsLock, type Claim, type Guest } from "./checkout-guests";
import { gitRepoStatus } from "./repo-edits";
import { listRunWorkspacePaths, loadPrototypeConfig, openProjectTaskOwnsRows, recordEvidence, type LanePilotDatabase } from "../../storage";
import { resolve } from "node:path";

/**
 * The window region (SMA k_v_status and its region): a window is an ordinary BB chat working in a project checkout,
 * remembered as a checkout-guest lease. A window may announce named claims of file globs — advisory only: collisions
 * are shown and never refuse. The verbs here are the person's door: status shows, claim announces, release ends a
 * claim saying what edits it left, force-clear removes a foreign claim only with a recorded reason.
 */

type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };

/** A live lease with the folder it works in. */
export type LiveWindow = Guest & { path: string };

/** The live guests across every checkout path of a project (a project may merge more than one folder). */
export async function listLiveWindows(kv: Kv, paths: readonly string[], now = Date.now()): Promise<LiveWindow[]> {
  const windows: LiveWindow[] = [];
  for (const path of paths) for (const guest of await listGuests(kv as never, path, now)) windows.push({ ...guest, path: resolve(path) });
  return windows;
}

/** The claims of the folder's live leases: a claim dies with its lease, so expired leases hold nothing. */
export async function listClaims(kv: Kv, path: string, now = Date.now()): Promise<Claim[]> {
  return (await listGuests(kv as never, path, now)).flatMap((guest) => guest.claims ?? []);
}

const NAME = /^[\w][\w .:-]{0,79}$/;
const GLOBS_MAX = 20;
const GLOB_CHARS = 200;
/** A commit id as git prints it: it goes into a git command, so nothing else is accepted. */
const BASE_SHA = /^[0-9a-f]{7,64}$/;
const WHOLE_TREE = new Set(["**", "*", "**/*", "."]);
function globProblem(glob: unknown): string | null {
  if (typeof glob !== "string" || !glob.trim()) return "empty";
  const clean = glob.trim();
  if (clean.length > GLOB_CHARS) return `refused: a glob is at most ${GLOB_CHARS} characters`;
  if (WHOLE_TREE.has(clean.replace(/^\.\//, "").replace(/\/+$/, "") || ".")) return `refused: ${clean} claims the whole tree; name the folders or files`;
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").includes("..")) return `refused: ${clean} (claims are relative paths inside the checkout)`;
  return null;
}

export type ClaimResult = { ok: true; claim: Claim } | { ok: false; code: "invalid_name" | "invalid_glob" | "invalid_base" | "too_many_claims" | "claim_taken"; holder?: string; why: string };

/**
 * Announce a named claim of file globs on the caller's lease (SMA k_lib_claims). One serialized read-modify-write per
 * folder: exactly one racer wins a name, and the claim is every glob or none. A name a live lease of another thread
 * holds is refused with the holder; an expired lease's claim is replaced. The caller's own same-name claim is re-set.
 */
export async function claimScope(kv: Kv, input: { path: string; threadId: string; name: string; globs: readonly string[]; description?: string; base?: string | null; now?: number }): Promise<ClaimResult> {
  const now = input.now ?? Date.now();
  if (!NAME.test(input.name)) return { ok: false, code: "invalid_name", why: `claim name '${input.name}' is not a short label` };
  const globs = input.globs.map((glob) => glob.trim());
  const problem = globs.map(globProblem).find((why) => why !== null);
  if (globs.length > GLOBS_MAX) return { ok: false, code: "invalid_glob", why: `refused: a claim names at most ${GLOBS_MAX} globs` };
  if (input.base != null && !BASE_SHA.test(input.base)) return { ok: false, code: "invalid_base", why: "refused: base is a commit id (7-64 hex characters)" };
  if (!globs.length || problem) return { ok: false, code: "invalid_glob", why: `invalid glob ${problem ?? "list is empty"}` };
  return withGuestsLock(input.path, async () => {
    const stored = await allGuests(kv as never, input.path);
    const live = stored.filter((row) => now - row.at < GUEST_TTL_MS);
    const holder = live.find((row) => row.threadId !== input.threadId && (row.claims ?? []).some((claim) => claim.name === input.name));
    if (holder) return { ok: false, code: "claim_taken" as const, holder: holder.threadId, why: `claim '${input.name}' is held by ${holder.threadId}` };
    const mineBefore = stored.find((row) => row.threadId === input.threadId);
    const held = live.reduce((sum, row) => sum + (row.claims?.length ?? 0), 0);
    if (held >= CLAIMS_MAX && !mineBefore?.claims?.some((row) => row.name === input.name)) return { ok: false, code: "too_many_claims" as const, why: `refused: ${resolve(input.path)} already holds ${held} live claims (limit ${CLAIMS_MAX}); release one first` };
    const claim: Claim = { name: input.name, globs, description: (input.description ?? "").slice(0, 300), base: input.base ?? null, threadId: input.threadId, at: now };
    // An expired lease holds nothing: its old claims do not come back with the new one.
    const mine = mineBefore && now - mineBefore.at < GUEST_TTL_MS ? mineBefore : { ...mineBefore, threadId: input.threadId, at: now, claims: [] as Claim[] };
    mine.at = now;
    mine.claims = [...(mine.claims ?? []).filter((row) => row.name !== input.name), claim];
    await saveGuests(kv as never, input.path, [mine, ...stored.filter((row) => row.threadId !== input.threadId)]);
    return { ok: true as const, claim };
  });
}

export type ReleaseResult = { ok: true; claim: Claim } | { ok: false; code: "no_claim" | "not_holder"; holder?: string; why: string };

/** End the caller's own claim; only the holder may (a foreign claim goes through force-clear with a reason on record). */
export async function releaseClaim(kv: Kv, input: { path: string; threadId: string; name: string }): Promise<ReleaseResult> {
  return withGuestsLock(input.path, async () => {
    const stored = await allGuests(kv as never, input.path);
    const holder = stored.find((row) => (row.claims ?? []).some((claim) => claim.name === input.name));
    if (!holder) return { ok: false, code: "no_claim" as const, why: `no claim '${input.name}' in ${input.path}` };
    if (holder.threadId !== input.threadId) return { ok: false, code: "not_holder" as const, holder: holder.threadId, why: `claim '${input.name}' is held by ${holder.threadId}` };
    const claim = holder.claims!.find((row) => row.name === input.name)!;
    holder.claims = holder.claims!.filter((row) => row.name !== input.name);
    await saveGuests(kv as never, input.path, stored);
    return { ok: true as const, claim };
  });
}

/** Remove a claim whoever holds it, live or expired; the caller records the reason first (the verb refuses without one). */
export async function forceClearClaim(kv: Kv, input: { path: string; name: string }): Promise<{ cleared: boolean; holder?: string; path: string }> {
  return withGuestsLock(input.path, async () => {
    const stored = await allGuests(kv as never, input.path);
    const holder = stored.find((row) => (row.claims ?? []).some((claim) => claim.name === input.name));
    if (!holder) return { cleared: false, path: input.path };
    holder.claims = holder.claims!.filter((row) => row.name !== input.name);
    await saveGuests(kv as never, input.path, stored);
    return { cleared: true, holder: holder.threadId, path: input.path };
  });
}

/** The claim named `name` anywhere in the project's checkout paths (verbs search all paths: a window leases the folder it sends from). */
export async function findClaim(kv: Kv, paths: readonly string[], name: string): Promise<{ path: string; claim: Claim; leaseAt: number } | null> {
  for (const path of paths) {
    for (const guest of await allGuests(kv as never, path)) {
      const claim = (guest.claims ?? []).find((row) => row.name === name);
      if (claim) return { path: resolve(path), claim, leaseAt: guest.at };
    }
  }
  return null;
}

export type WindowCollision = { a: string; b: string; kind: "claim" | "task" };

/**
 * The overlaps to show a person (SMA k_lib_collision): claim against claim and claim against an open task's
 * owns_paths. Read-only and advisory — it returns pairs, never blocks; any malformed input gives an empty list.
 */
export function windowCollisions(claims: readonly { name: string; globs: readonly string[] }[], tasks: readonly { id: string; globs: readonly string[] }[]): WindowCollision[] {
  try {
    const out: WindowCollision[] = [];
    const sane = (row: { globs: readonly string[] }) => Array.isArray(row.globs) && row.globs.every((glob) => typeof glob === "string");
    const list = claims.filter((row) => row && typeof row.name === "string" && sane(row));
    const open = tasks.filter((row) => row && typeof row.id === "string" && sane(row));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) if (ownsPathsOverlap([...list[i]!.globs], [...list[j]!.globs])) out.push({ a: list[i]!.name, b: list[j]!.name, kind: "claim" });
      for (const task of open) if (ownsPathsOverlap([...list[i]!.globs], [...task.globs])) out.push({ a: list[i]!.name, b: task.id, kind: "task" });
    }
    return out;
  } catch {
    return [];
  }
}

export type WorkFingerprint = { branch: string | null; paths: string[] };

/**
 * What the folder is doing right now, read from the tree itself (SMA k_lib_fingerprint): current branch and the dirty
 * paths (50 at most). Read-only; a host that cannot answer gives an empty fingerprint. Dirt cannot be attributed to a
 * thread, so it is shown per folder.
 */
export async function workFingerprint(host: RunCommandHost, hostId: string, cwd: string): Promise<WorkFingerprint> {
  try {
    const branch = await runOnHost(host, { hostId, cwd, command: "git rev-parse --abbrev-ref HEAD", timeoutSec: 15, timeoutMs: 20_000 }).catch(() => null);
    const status = await gitRepoStatus(host as never, hostId, cwd).catch(() => null);
    return { branch: branch && branch.exitCode === 0 ? branch.stdout.trim() || null : null, paths: status ? [...status].slice(0, 50) : [] };
  } catch {
    return { branch: null, paths: [] };
  }
}

/** The project's checkout paths a window can lease: the configured PM and writer workspaces plus the 5 newest run writer paths. */
export function projectCheckoutPaths(db: LanePilotDatabase, projectId: string): string[] {
  const config = loadPrototypeConfig(db, projectId);
  return [...new Set([config?.pmWorkspacePath, config?.writerWorkspacePath, ...listRunWorkspacePaths(db, projectId, 5)].filter((path): path is string => typeof path === "string" && path.length > 0))].map((path) => resolve(path));
}

type CliOut = { exitCode: number; stdout?: string; stderr?: string };
/** `threadId` is the invocation's thread (absent: the owner at a terminal); `thread` reads a thread's project, null when it does not exist. */
type WindowDeps = { db: LanePilotDatabase; kv: Kv; host: RunCommandHost; threadId?: string | null; thread?: (threadId: string) => Promise<{ projectId?: string | null } | null> };

/** Fingerprints run a few at a time: status on a project with many folders must not flood the host. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const at = next++; out[at] = await fn(items[at]!); }
  }));
  return out;
}

function openTaskOwns(db: LanePilotDatabase, projectId: string): Array<{ id: string; globs: string[] }> {
  return openProjectTaskOwnsRows(db, projectId).flatMap((row) => {
    try {
      const contract = JSON.parse(row.contract_json) as { owns_paths?: unknown };
      const globs = Array.isArray(contract.owns_paths) ? contract.owns_paths.filter((glob): glob is string => typeof glob === "string") : [];
      return globs.length ? [{ id: row.task_id, globs }] : [];
    } catch { return []; }
  });
}

async function headSha(host: RunCommandHost, hostId: string, cwd: string): Promise<string | null> {
  const ran = await runOnHost(host, { hostId, cwd, command: "git rev-parse HEAD", timeoutSec: 15, timeoutMs: 20_000 }).catch(() => null);
  const sha = ran && ran.exitCode === 0 ? ran.stdout.trim() : "";
  return BASE_SHA.test(sha) ? sha : null;
}

async function gitList(host: RunCommandHost, hostId: string, cwd: string, command: string): Promise<string[]> {
  const ran = await runOnHost(host, { hostId, cwd, command, timeoutSec: 30, timeoutMs: 35_000 }).catch(() => null);
  if (!ran || ran.exitCode !== 0) return [];
  return ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

const quoted = (globs: readonly string[]) => globs.map((glob) => `'${glob.replace(/'/g, `'\\''`)}'`).join(" ");

/** Who may claim or release for `threadId`: a chat only for itself and only in its own project; the owner at a terminal for an existing thread (claim). */
async function callerRefusal(deps: WindowDeps, projectId: string, threadId: string, verb: "claim" | "release"): Promise<string | null> {
  if (deps.threadId) {
    if (deps.threadId !== threadId) return `refused: a chat claims and releases only for itself (you are ${deps.threadId}, not ${threadId})`;
    const own = await deps.thread?.(deps.threadId);
    if (!own || typeof own.projectId !== "string" || own.projectId !== projectId) return `refused: window ${verb} from a chat reaches only that chat's own project (${typeof own?.projectId === "string" ? own.projectId : "unknown"}), not ${projectId}`;
    return null;
  }
  if (verb === "claim" && deps.thread && !(await deps.thread(threadId))) return `refused: no thread ${threadId}; nothing was stored`;
  return null;
}

export const WINDOW_USAGE =
  "bb lane-pilot window status <project-id> [--json] | window claim <project-id> <thread-id> <name> <glob,glob> [description] | window release <project-id> <thread-id> <name> [--outcome committed|abandoned|handed_off] | window force-clear <project-id> <name> --reason <text>";

/** The window verbs (SMA k_v_status, k_v_claim, k_v_release, k_v_forceclear). Claims are advisory: they never refuse a merge, they only show. */
export async function runWindowCli(deps: WindowDeps, args: string[]): Promise<CliOut> {
  const { db, kv, host } = deps;
  const [sub, projectId, ...rest] = args;
  if (!projectId || !["status", "claim", "release", "force-clear"].includes(sub ?? "")) return { exitCode: 1, stderr: `usage: ${WINDOW_USAGE}` };
  // status is open to all; force-clear is the owner's alone (a thread is an agent); claim and release are a chat's own.
  if (sub === "force-clear" && deps.threadId) return { exitCode: 1, stderr: "refused: window force-clear is for the owner at a terminal, not from a chat: ask them to run it" };
  const paths = projectCheckoutPaths(db, projectId);
  if (!paths.length) return { exitCode: 1, stderr: `project ${projectId} has no checkout bound in Lane Pilot` };
  const config = loadPrototypeConfig(db, projectId);
  const hostId = config?.hostId ?? null;
  const mainPath = resolve(config?.writerWorkspacePath ?? paths[0]!);

  if (sub === "status") {
    const now = Date.now();
    const windows = await listLiveWindows(kv, paths, now);
    const tasks = openTaskOwns(db, projectId);
    const claims = windows.flatMap((win) => (win.claims ?? []).map((claim) => ({ ...claim, holder: win.threadId })));
    const collisions = windowCollisions(claims.map((claim) => ({ name: `${claim.name} (${claim.holder})`, globs: claim.globs })), tasks);
    const fingerprints = hostId ? await mapLimit(paths, 3, async (path) => ({ path, ...(await workFingerprint(host, hostId, path)) })) : paths.map((path) => ({ path, branch: null, paths: [] as string[] }));
    // A dirty path that falls under an open task's or a claim's scope is flagged, so a window that never claimed is still seen.
    const owned = (file: string) => {
      const task = tasks.find((row) => ownsPathsOverlap(row.globs, [file]) || row.globs.some((glob) => file === glob || file.startsWith(`${glob.replace(/\/\*\*$/, "")}/`)));
      const claim = claims.find((claim) => claim.globs.some((glob) => file === glob || file.startsWith(`${glob.replace(/\/\*\*$/, "")}/`)));
      return task ? `task:${task.id}` : claim ? `claim:${claim.name}` : null;
    };
    const report = {
      projectId,
      windows: windows.map((win) => ({ thread: win.threadId, provider: win.providerId ?? null, label: win.label ?? null, path: win.path, idleMinutes: Math.round((now - win.at) / 60_000), claims: win.claims ?? [] })),
      openTasks: tasks,
      collisions,
      fingerprints: fingerprints.map((fp) => ({ ...fp, paths: fp.paths.map((file) => ({ file, under: owned(file) })) })),
    };
    if (rest.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(report, null, 2) };
    const lines = [`windows of ${projectId}:`];
    for (const win of report.windows) {
      lines.push(`  ${win.thread}${win.provider ? ` (${win.provider})` : ""} in ${win.path} — last send ${win.idleMinutes}m ago`);
      for (const claim of win.claims) lines.push(`    claim ${claim.name}: ${claim.globs.join(", ")}${claim.description ? ` — ${claim.description}` : ""}${claim.base ? ` @${claim.base.slice(0, 8)}` : ""}`);
    }
    if (!report.windows.length) lines.push("  no live windows");
    for (const task of tasks) lines.push(`  task ${task.id} owns ${task.globs.join(", ")}`);
    for (const hit of collisions) lines.push(`  collision: ${hit.a} overlaps ${hit.b} (${hit.kind})`);
    for (const fp of report.fingerprints) lines.push(`  ${fp.path} on ${fp.branch ?? "?"}: ${fp.paths.length ? fp.paths.map((row) => `${row.file}${row.under ? ` [${row.under}]` : ""}`).join(", ") : "clean"}`);
    return { exitCode: 0, stdout: lines.join("\n") };
  }

  if (sub === "claim") {
    const [threadId, name, globList, ...words] = rest.filter((arg) => !arg.startsWith("--"));
    if (!threadId || !name || !globList) return { exitCode: 1, stderr: `usage: ${WINDOW_USAGE}` };
    const refused = await callerRefusal(deps, projectId, threadId, "claim");
    if (refused) return { exitCode: 1, stderr: refused };
    const globs = globList.split(",").map((glob) => glob.trim()).filter(Boolean);
    // The claim lands on the lease the thread already holds; a thread with no noted lease claims the main checkout.
    const leased = (await listLiveWindows(kv, paths)).find((win) => win.threadId === threadId)?.path ?? mainPath;
    const result = await claimScope(kv, { path: leased, threadId, name, globs, description: words.join(" "), base: hostId ? await headSha(host, hostId, leased) : null });
    if (!result.ok) return { exitCode: 1, stderr: result.why };
    const windows = await listLiveWindows(kv, paths);
    const claims = windows.flatMap((win) => (win.claims ?? []).map((claim) => ({ ...claim, holder: win.threadId })));
    const collisions = windowCollisions(claims.map((claim) => ({ name: `${claim.name} (${claim.holder})`, globs: claim.globs })), openTaskOwns(db, projectId)).filter((hit) => hit.a.startsWith(`${name} (`) || hit.b.startsWith(`${name} (`));
    const lines = [`claimed ${name}: ${globs.join(", ")} in ${leased}`];
    for (const hit of collisions) lines.push(`collision: ${hit.a} overlaps ${hit.b} (${hit.kind})`);
    return { exitCode: 0, stdout: lines.join("\n") };
  }

  if (sub === "release") {
    const [threadId, name] = rest.filter((arg) => !arg.startsWith("--"));
    if (!threadId || !name) return { exitCode: 1, stderr: `usage: ${WINDOW_USAGE}` };
    const refused = await callerRefusal(deps, projectId, threadId, "release");
    if (refused) return { exitCode: 1, stderr: refused };
    const outcomeAt = rest.indexOf("--outcome");
    const outcome = outcomeAt >= 0 ? rest[outcomeAt + 1] : "committed";
    if (!outcome || !["committed", "abandoned", "handed_off"].includes(outcome)) return { exitCode: 1, stderr: "--outcome is committed|abandoned|handed_off" };
    const found = await findClaim(kv, paths, name);
    if (!found) return { exitCode: 1, stderr: `no claim '${name}' in this project's checkouts` };
    if (found.claim.threadId !== threadId) return { exitCode: 1, stderr: `refused: claim '${name}' is held by ${found.claim.threadId}, not ${threadId}; use window force-clear --reason` };
    const editsLeft = hostId ? await gitList(host, hostId, found.path, `git status --porcelain -uall -- ${quoted(found.claim.globs)}`) : [];
    const files = hostId && found.claim.base && BASE_SHA.test(found.claim.base) ? await gitList(host, hostId, found.path, `git diff --name-only ${quoted([found.claim.base])}`) : [];
    // The attempt trail a worker leaves, for a person's window (SMA k_lib_termattempt): base, files, outcome. Written first.
    const written = await recordEvidence(kv as never, {
      op: "window", projectId, target: name, why: `released by ${threadId}`,
      checks: [
        { name: "base", ok: true, detail: found.claim.base ?? "unknown" },
        { name: "files", ok: true, detail: files.join(", ") || "none" },
        { name: "outcome", ok: outcome !== "abandoned", detail: outcome },
      ],
      by: threadId, at: Date.now(),
    });
    const released = await releaseClaim(kv, { path: found.path, threadId, name });
    if (!released.ok) return { exitCode: 1, stderr: released.why };
    return { exitCode: 0, stdout: [`released ${name} (${outcome})`, `edits_left: ${editsLeft.length ? editsLeft.join(", ") : "none"}`, ...(written ? [] : ["evidence not written; the claim is released anyway"])].join("\n") };
  }

  // force-clear: a foreign claim goes only with a reason on record (the evidence discipline of permit, revert, janitor).
  const [name] = rest.filter((arg) => !arg.startsWith("--"));
  const reasonAt = rest.indexOf("--reason");
  const reason = reasonAt >= 0 ? rest.slice(reasonAt + 1).filter((arg) => !arg.startsWith("--")).join(" ").trim() : "";
  if (!name || !reason) return { exitCode: 1, stderr: `refused: window force-clear needs a reason on record — bb lane-pilot window force-clear ${projectId} <name> --reason <text>` };
  const found = await findClaim(kv, paths, name);
  if (!found) return { exitCode: 1, stderr: `no claim '${name}' in this project's checkouts` };
  const written = await recordEvidence(kv as never, {
    op: "window", projectId, target: name, why: reason,
    checks: [
      { name: "holder", ok: true, detail: found.claim.threadId },
      { name: "lease_age_minutes", ok: true, detail: String(Math.round((Date.now() - found.leaseAt) / 60_000)) },
    ],
    by: "cli", at: Date.now(),
  });
  if (!written) return { exitCode: 1, stderr: "evidence not written; nothing cleared" };
  await forceClearClaim(kv, { path: found.path, name });
  return { exitCode: 0, stdout: `cleared ${name} (was held by ${found.claim.threadId})` };
}
