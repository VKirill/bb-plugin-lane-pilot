import { appendFile, mkdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { bestEffort, spawnAsync } from "@lane-pilot/kit";

/**
 * The strict worker (SMA map: Separate worker user, Checks as the worker, Folder rights for the worker, List of granted rights,
 * Reachability probe). With the project setting worker.strict_user on, a check runs as a separate OS user (worker.user, `lp-worker` by
 * default) through `sudo -n -u`, inside the same sandbox: the user gets rights on the run folder and the job's temp folder only, every grant
 * is written to ~/.lane-pilot/worker-grants.jsonl, and a worker sudo cannot reach stops the check with what to do. The user is made once by
 * an admin with scripts/lp-worker-user.sh create.
 */
export const WORKER_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
export const DEFAULT_WORKER = "lp-worker";
const SUDO = "/usr/bin/sudo";

/** Reachability probe: sudo runs a no-op as the worker without a password. */
export async function workerReachable(user: string): Promise<boolean> {
  if (!WORKER_USER.test(user)) return false;
  const probe = await spawnAsync(SUDO, ["-n", "-u", user, "/usr/bin/true"], { timeout: 10_000 });
  return probe.status === 0;
}

/** The rights a worker gets on a folder (and what it creates there inherits); the owner keeps his on what the worker makes. */
export function grantCommands(platform: string, user: string, owner: string, dir: string): Array<{ program: string; args: string[] }> {
  if (platform === "darwin") {
    const rights = "read,write,execute,delete,append,readattr,writeattr,readextattr,writeextattr,readsecurity,list,search,add_file,add_subdirectory,delete_child,file_inherit,directory_inherit";
    return [
      { program: "/bin/chmod", args: ["-R", "-a", `user:${user} allow ${rights}`, dir] },
      { program: "/bin/chmod", args: ["-R", "+a", `user:${user} allow ${rights}`, dir] },
      { program: "/bin/chmod", args: ["-R", "+a", `user:${owner} allow ${rights}`, dir] },
    ];
  }
  return [{ program: "setfacl", args: ["-R", "-m", `u:${user}:rwX,d:u:${user}:rwX,u:${owner}:rwX,d:u:${owner}:rwX`, dir] }];
}

/** Folder rights for the worker, each grant written to the list of granted rights. */
export async function grantRunFolders(user: string, dirs: readonly string[], platform = process.platform): Promise<string[]> {
  const owner = userInfo().username;
  const granted: string[] = [];
  for (const dir of dirs) {
    let ok = true;
    for (const step of grantCommands(platform, user, owner, dir)) {
      const done = await spawnAsync(step.program, step.args, { timeout: 60_000 });
      // Removing a grant that is not there fails on a Mac; only adding one counts.
      if (done.status !== 0 && !step.args.includes("-a")) ok = false;
    }
    if (ok) granted.push(dir);
  }
  const ledger = join(homedir(), ".lane-pilot", "worker-grants.jsonl");
  await mkdir(join(homedir(), ".lane-pilot"), { recursive: true });
  await bestEffort(console.warn, `worker grants ledger ${ledger}`, appendFile(ledger, granted.map((dir) => JSON.stringify({ at: Date.now(), user, owner, path: dir })).join("\n") + (granted.length ? "\n" : "")), undefined);
  return granted;
}

/** The launch as the worker: sudo keeps exactly the named variables (the sandbox's own and the check's secrets), nothing else. */
export function asWorker(user: string, program: string, args: readonly string[], keep: readonly string[]): { program: string; args: string[] } {
  if (!WORKER_USER.test(user)) throw new Error(`worker_user_invalid: ${user}`);
  return { program: SUDO, args: ["-n", "-u", user, ...(keep.length ? [`--preserve-env=${[...new Set(keep)].join(",")}`] : []), program, ...args] };
}

/** The owner's credential paths a worker should not read (SMA m_ac_identity_probe); each is probed with `test -r` as the worker. `~/.lane-pilot` is not one: the worker's own worktrees and jobs live there by design, and no single credential file under it is known. */
export const WORKER_SECRET_PATHS = [".ssh", ".codex/auth.json", ".claude/.credentials.json", ".aws", ".gnupg"] as const;

/** Identity probe: the worker OS user cannot reach the owner's secrets. A readable path is reported as exposed; it is a warning, never a failing exit. */
export async function workerSecretReach(user: string, ownerHome = homedir()): Promise<{ ok: boolean; reachable: string[] }> {
  if (!WORKER_USER.test(user)) throw new Error(`worker_user_invalid: ${user}`);
  const reachable: string[] = [];
  for (const rel of WORKER_SECRET_PATHS) {
    const probe = await spawnAsync(SUDO, ["-n", "-u", user, "/usr/bin/test", "-r", join(ownerHome, rel)], { timeout: 10_000 });
    if (probe.status === 0) reachable.push(join(ownerHome, rel));
  }
  return { ok: reachable.length === 0, reachable };
}
