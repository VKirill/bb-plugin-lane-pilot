import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bestEffort, createCapture, lstatOrNull, redactSecrets, sha256Hex } from "@lane-pilot/kit";
import { spawnAsync } from "@lane-pilot/kit";
import { asWorker, grantRunFolders, workerReachable } from "./worker-user";

export type SandboxedCommandInput = {
  requestedHostId:string; workspacePath:string; cwd:string; command:string; backend?:"auto"|"macos-seatbelt"|"linux-bubblewrap"; timeoutSec?:number;
  /** Secret values for this command (Env Catalog): set in its environment, masked in what it printed. */
  env?:Record<string,string>;
  /** Run as this OS user (worker.strict_user on): sudo -n -u, rights on the run folder granted and listed (worker-user.ts). */
  asUser?:string;
  /** Hash .git/.agents/.cls before and after (only the check-measure path asks: the walk costs time and its result is used nowhere else). */
  protectedRoots?:boolean;
};
export type SandboxedCommandResult = {
  hostId:string; backend:"macos-seatbelt"|"linux-bubblewrap"; workspacePath:string; cwd:string; exitCode:number;
  policySha256:string;
  /** .git/.agents/.cls hashed before and after (SMA m_ck_isolated); a change fails the check. */
  rootsManifest?:{ before:string; after:string; changed:boolean; partial?:boolean; git?:RootsGit };
  stdout:string; stderr:string;
};

/**
 * The roots a sandboxed check must leave untouched (SMA m_ck_isolated): .git, .agents, .cls, hashed before and after.
 * One digest over path/size/mtime rows, sorted. The walk is async and bounded by wall time (PROTECTED_MANIFEST_BUDGET_MS per
 * manifest) and by row count; past either the manifest is `partial` and a partial manifest never counts as changed.
 * `.agents/runs` (the run bookkeeping that changes all the time) is skipped. In a linked worktree `.git` is a file that names
 * the real git directory: that directory is walked (`git:"worktree-gitdir"` — its own HEAD/index/hooks, not the shared refs
 * and objects of the main repository); a pointer that cannot be followed is `git:"uncovered"`, never a silent nothing.
 */
export const PROTECTED_ROOTS = [".git",".agents",".cls"] as const;
export const PROTECTED_MANIFEST_CAP = 50_000;
export const PROTECTED_MANIFEST_BUDGET_MS = 2_000;
export type RootsGit = "covered"|"worktree-gitdir"|"uncovered"|"absent";
export type RootsManifest = {sha256:string;entries:number;truncated:boolean;partial:boolean;git:RootsGit};
export async function protectedRootsManifest(workspacePath:string, options:{cap?:number;budgetMs?:number} = {}):Promise<RootsManifest> {
  const cap=options.cap ?? PROTECTED_MANIFEST_CAP;
  const deadline=Date.now()+(options.budgetMs ?? PROTECTED_MANIFEST_BUDGET_MS);
  const skipped=join(workspacePath,".agents","runs");
  const rows:string[]=[];
  let truncated=false, timedOut=false, git:RootsGit="absent";
  const roots:Array<{dir:string;label:string}>=[];
  for (const name of PROTECTED_ROOTS) {
    const path=join(workspacePath,name);
    const info=await lstat(path).catch(()=>null);
    if (!info) continue;
    if (name!==".git") { roots.push({dir:path,label:name}); continue; }
    if (info.isDirectory()) { git="covered"; roots.push({dir:path,label:name}); continue; }
    // A linked worktree: `.git` is a file, "gitdir: <path>".
    const pointer=info.isFile() ? /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(path,"utf8").catch(()=>"")) : null;
    const target=pointer ? resolve(workspacePath,pointer[1]!) : null;
    const real=target ? await lstat(target).catch(()=>null) : null;
    if (target && real?.isDirectory()) { git="worktree-gitdir"; roots.push({dir:target,label:".git(worktree)"}); }
    else git="uncovered";
  }
  for (const root of roots) {
    const stack=[root.dir];
    while (stack.length) {
      if (rows.length>=cap) { truncated=true; break; }
      if (Date.now()>deadline) { timedOut=true; break; }
      const dir=stack.pop()!;
      const listing=await readdir(dir,{withFileTypes:true}).catch(()=>null);
      if (!listing) continue;
      const files:Array<{path:string;link:boolean}>=[];
      for (const entry of listing) {
        const path=join(dir,entry.name);
        if (path===skipped) continue;
        if (entry.isDirectory()) stack.push(path);
        else files.push({path,link:entry.isSymbolicLink()});
      }
      const stats=await Promise.all(files.map((file)=>lstat(file.path).catch(()=>null)));
      files.forEach((file,index)=>{
        const st=stats[index];
        const name=join(root.label,relative(root.dir,file.path));
        rows.push(st ? `${name}:${file.link?"l":"f"}:${st.size}:${Math.trunc(st.mtimeMs)}` : `${name}:?`);
      });
    }
    if (truncated||timedOut) break;
  }
  rows.sort();
  return { sha256:sha256Hex(rows.join("\n")), entries:rows.length, truncated, partial:truncated||timedOut, git };
}

/** Credential stores a publish would reach for (SMA m_ck_required): masked in the sandbox so a check can use the net but not publish. */
export function credentialMaskPaths(home = homedir()):{dirs:string[];files:string[]} {
  const dirs=[".ssh",".gnupg",".aws",".azure",join(".config","gh")].map((name)=>join(home,name)).filter((path)=>existsSync(path));
  const files=[".git-credentials",".netrc"].map((name)=>join(home,name)).filter((path)=>existsSync(path));
  return {dirs,files};
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
import { SANDBOX_OWN_ENV } from "../contracts";
/**
 * What a check keeps of its output: the beginning and the end of each stream. The command is never stopped for printing
 * more: a 1 MB cap killed SelfyStudio's green API vitest (2.5 MB of request logs) and read the kill as exit 1, so every
 * replay before a merge was «red» (2026-10-14/15). The end holds the failures and the summary.
 */
const KEEP_STDOUT = 200_000;
const KEEP_STDERR = 24_000;

/** The beginning and the end of `text`, at most `cap` bytes. */
function keepEnds(text:string, cap:number):string {
  const capture=createCapture(cap);
  capture.push(Buffer.from(text,"utf8"));
  return capture.text();
}
const MAX_TIMEOUT_MS = 7_200_000;
const BWRAP_CANDIDATES = ["/usr/bin/bwrap","/bin/bwrap"] as const;

export type SandboxBackendRequest = "auto"|"macos-seatbelt"|"linux-bubblewrap";

/** Resolve only backends whose policy has been implemented and verified on this host. */
export function resolveSandboxBackend(requested:SandboxBackendRequest, platform:string, seatbeltAvailable:boolean, bubblewrapAvailable=false):"macos-seatbelt"|"linux-bubblewrap" {
  const selected=requested === "auto" ? (platform === "darwin" ? "macos-seatbelt" : platform === "linux" ? "linux-bubblewrap" : null) : requested;
  if (!selected || (selected === "macos-seatbelt" && platform !== "darwin") || (selected === "linux-bubblewrap" && platform !== "linux")) {
    throw new Error("sandbox_backend_unavailable: no verified backend for this host platform");
  }
  if (selected === "macos-seatbelt" && !seatbeltAvailable) throw new Error("sandbox_backend_unavailable: macOS Seatbelt executable is missing");
  if (selected === "linux-bubblewrap" && !bubblewrapAvailable) throw new Error("sandbox_backend_unavailable: bubblewrap executable is missing");
  return selected;
}

function within(root:string, path:string):boolean {
  const rel = relative(root,path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sbplPath(path:string):string {
  if (!isAbsolute(path) || /[\0\n\r"\\]/.test(path)) {
    throw new Error("sandbox path must be an absolute single-line path");
  }
  return `"${path}"`;
}

export function buildSeatbeltProfile(workspacePath:string, tempPath:string, credentialMask?:{dirs?:string[];files?:string[]}):string {
  const workspace = sbplPath(workspacePath);
  const temporary = sbplPath(tempPath);
  const denyWrites = [".git", ".agents", ".cls"].map((name) => `(deny file-write* (subpath ${sbplPath(resolve(workspacePath,name))}))`).join("\n");
  // Closed publication (SMA m_ck_required): the credential stores a push would reach for are unreadable inside the check.
  const denyReads = [...(credentialMask?.dirs ?? []).map((dir) => `(deny file-read* (subpath ${sbplPath(dir)}))`),
    ...(credentialMask?.files ?? []).map((file) => `(deny file-read* (literal ${sbplPath(file)}))`)].join("\n");
  return [
    "(version 1)",
    "(allow default)",
    // Network stays open: checks such as curl against a dev server or an API must be able to pass.
    // The shared /tmp stays writable: a check that drives an app outside the sandbox talks to it through files there (Vampirism Fire's
    // studio_test.py: a lock and the run's files in /tmp/vf-tests, read by Roblox Studio; «Operation not permitted», 2026-10-23).
    `(deny file-write* (require-all (require-not (subpath ${workspace})) (require-not (subpath ${temporary})) (require-not (subpath \"/private/tmp\")) (require-not (literal \"/dev/null\"))))`,
    denyWrites,
    denyReads,
  ].join("\n");
}

/** Build an argv-only bubblewrap policy. Sensitive workspace entries are bind-mounted read-only. */
/** The folder of the bb CLI, so checks like `bb plugin build` run inside the sandbox; null when absent. */
export function bbCliDir(env:NodeJS.ProcessEnv = process.env):string|null {
  const pinned = env.BB_CLI?.trim();
  if (pinned && isAbsolute(pinned)) return dirname(pinned);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    try { accessSync(join(dir,"bb"),fsConstants.X_OK); return dir; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * BB's data folder, where `bb plugin build` keeps its build toolchain. The sandbox moves HOME into a temp
 * folder, so without this `bb` looked for the toolchain there, tried to download it and failed with
 * «Cannot find module 'npm/package.json'» — every `npm run build` of a BB plugin failed acceptance
 * (project-folders, 2026-10-02). Reading it is allowed; the sandbox still writes only the workspace and temp.
 */
export function bbDataDir(env:NodeJS.ProcessEnv = process.env):string {
  const pinned = env.BB_DATA_DIR?.trim();
  return pinned && isAbsolute(pinned) ? pinned : join(homedir(),".bb");
}

/**
 * Tools a user installs into their own home: rokit (rojo, lune, selene…), aftman, foreman, cargo, bun, deno, go, pipx/uv in ~/.local/bin.
 * The sandbox's HOME is a temp folder and its PATH the system folders only, so a project's own toolchain was «command not found»
 * (exit 127: Vampirism Fire's `scripts/check.sh` ran rojo and lune, 2026-10-23) and rokit, finding no ~/.rokit, made one in the
 * repository, which the owns check then charged to the writer. The bin folders that exist go on PATH, and the tool homes are linked
 * into the temp HOME: read, the user's settings and installed tools; written, nothing (the sandbox allows writes only in the
 * workspace and the temp folder).
 */
export const USER_TOOL_HOMES = [".rokit", ".aftman", ".foreman", ".cargo", ".rustup", ".bun", ".deno"] as const;
export const USER_TOOL_BINS = [".rokit/bin", ".aftman/bin", ".foreman/bin", ".cargo/bin", ".bun/bin", ".deno/bin", "go/bin", ".local/bin"] as const;

export function userToolBins(home:string = homedir()):string[] {
  return USER_TOOL_BINS.map((dir)=>join(home,dir)).filter((dir)=>existsSync(dir));
}

/**
 * Playwright keeps its browsers in the user's cache (~/.cache/ms-playwright on Linux, ~/Library/Caches/ms-playwright on macOS), and
 * under the temp HOME it looked there in vain: SelfyStudio's `node scripts/check-en-markup.mjs && node scripts/check-en-client.mjs`
 * stopped at «Executable doesn't exist at …/lane-pilot-sandbox-…/.cache/ms-playwright/…», green in the writer's shell (2026-10-24),
 * and cakekeeper's checks downloaded every browser again on each run. The temp HOME gets a cache folder of its own with a link per
 * installed browser: a launch finds them, and `playwright install` of a version the user has not got still writes into the temp
 * folder, as the user's cache is not writable from the sandbox.
 */
export const USER_BROWSER_CACHES = [".cache/ms-playwright", "Library/Caches/ms-playwright"] as const;
/**
 * Docker's CLI finds its plugins (`docker compose`, `docker buildx`) and its context through ~/.docker: under the temp HOME `docker compose`
 * was «unknown command» and a writer spent five attempts on a check it could not pass (Docker Desktop on macOS, 2026-10-28). The temp HOME
 * gets a .docker folder of its own with links to the config, the plugins and the contexts; the state Docker writes (buildx) stays the temp folder's.
 */
export const USER_DOCKER_ENTRIES = ["config.json", "cli-plugins", "contexts"] as const;

/** Links the user's tool homes that exist into the sandbox's temp HOME, and the browsers of the user's browser caches. */
export async function linkUserToolHomes(tempPath:string, home:string = homedir()):Promise<string[]> {
  const linked:string[]=[];
  for (const name of USER_TOOL_HOMES) {
    const source=join(home,name);
    if (!existsSync(source)) continue;
    await symlink(source,join(tempPath,name),"dir").then(()=>linked.push(name),()=>undefined);
  }
  for (const cache of USER_BROWSER_CACHES) {
    const source=join(home,cache);
    // Playwright's own lock (__dirlock) and link records (.links) stay the temp folder's.
    const browsers=await readdir(source,{withFileTypes:true}).then((entries)=>entries.filter((entry)=>entry.isDirectory()&&!/^(\.|__)/.test(entry.name)),()=>[]);
    if (!browsers.length) continue;
    await mkdir(join(tempPath,cache),{recursive:true});
    for (const browser of browsers) await symlink(join(source,browser.name),join(tempPath,cache,browser.name),"dir").then(()=>linked.push(join(cache,browser.name)),()=>undefined);
  }
  for (const entry of USER_DOCKER_ENTRIES) {
    const source=join(home,".docker",entry);
    if (!existsSync(source)) continue;
    await mkdir(join(tempPath,".docker"),{recursive:true});
    await symlink(source,join(tempPath,".docker",entry)).then(()=>linked.push(join(".docker",entry)),()=>undefined);
  }
  return linked;
}

function sandboxPath(base:string):string {
  const bb = bbCliDir();
  return [base, ...userToolBins(), ...(bb ? [bb] : [])].join(":");
}

export function buildBubblewrapArgs(input:{workspacePath:string;cwd:string;tempPath:string;guardPaths:string[];
  /** Credential stores masked out of the sandbox (SMA m_ck_required): dirs get an empty tmpfs, files /dev/null. */
  credentialMask?:{dirs?:string[];files?:string[]};
}):string[] {
  // --share-net keeps the host network while every other namespace stays private: a check may curl a dev
  // server or an API, but still writes only into the workspace and its temp folder. Before, --unshare-all
  // alone cut the network, so no curl verification could ever pass.
  // The shared /tmp stays writable (see buildSeatbeltProfile); the workspace and the guards are bound after it, so they still win.
  const args=["--die-with-parent","--new-session","--unshare-all","--share-net","--ro-bind","/","/","--bind","/tmp","/tmp","--bind",input.workspacePath,input.workspacePath];
  for (const guardPath of input.guardPaths) args.push("--ro-bind",guardPath,guardPath);
  for (const dir of input.credentialMask?.dirs ?? []) args.push("--tmpfs",dir);
  for (const file of input.credentialMask?.files ?? []) args.push("--ro-bind","/dev/null",file);
  args.push("--bind",input.tempPath,input.tempPath,"--proc","/proc","--dev","/dev","--chdir",input.cwd,
    "--clearenv","--setenv","PATH",sandboxPath("/usr/local/bin:/usr/bin:/bin"),"--setenv","HOME",input.tempPath,
    "--setenv","TMPDIR",input.tempPath,"--setenv","TMP",input.tempPath,"--setenv","TEMP",input.tempPath,
    "--setenv","BB_DATA_DIR",bbDataDir(),"--setenv","LANG","C","--setenv","LC_ALL","C","--","/bin/bash","--noprofile","--norc","-c");
  return args;
}

/** The variables a command may be given on top of the sandbox's own: valid names, never the sandbox's own ones. */
export function sandboxSecretEnv(env:Record<string,string>|undefined):Record<string,string> {
  const out:Record<string,string> = {};
  for (const [name,value] of Object.entries(env ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && !SANDBOX_OWN_ENV.has(name) && typeof value === "string" && !value.includes("\0")) out[name]=value;
  }
  return out;
}
const maskSecrets=(text:string,secrets:Record<string,string>)=>Object.keys(secrets).length?redactSecrets(text,Object.values(secrets)):text;

/** Guard paths the sandbox created, with how many running checks use each; checks of one attempt run at once. */
const createdGuardUsers=new Map<string,number>();
let guardLock:Promise<unknown>=Promise.resolve();

function underGuardLock<T>(work:()=>Promise<T>):Promise<T> {
  const turn=guardLock.then(work);
  guardLock=bestEffort(console.warn, "sandbox guard lock", turn, undefined);
  return turn;
}

/**
 * The workspace entries mounted read-only. One that is missing (a git-ignored cache a fresh worktree lacks) is
 * created empty so the mount still covers it, and removed after the last check using it; a symlink is refused.
 */
export function prepareGuardPaths(workspacePath:string):Promise<{guardPaths:string[];created:string[]}> {
  return underGuardLock(async()=>{
    const guardPaths:string[]=[], created:string[]=[];
    for (const name of [".git",".agents",".cls"]) {
      const guardPath=resolve(workspacePath,name);
      const users=createdGuardUsers.get(guardPath);
      if (users) {
        createdGuardUsers.set(guardPath,users+1);
        created.push(guardPath);
      } else {
        const info=await lstatOrNull(guardPath);
        if (info?.isSymbolicLink()) throw new Error(`sandbox_guard_path_symlink: ${name}; refusing to expose it writable`);
        if (!info) {
          await mkdir(guardPath);
          createdGuardUsers.set(guardPath,1);
          created.push(guardPath);
        }
      }
      guardPaths.push(guardPath);
    }
    return {guardPaths,created};
  });
}

/** Lets go of the guard paths prepareGuardPaths created; the last check using one removes it if still empty. */
export function releaseGuardPaths(created:string[]):Promise<void> {
  return underGuardLock(async()=>{
    for (const path of created) {
      const users=(createdGuardUsers.get(path) ?? 1)-1;
      if (users>0) { createdGuardUsers.set(path,users); continue; }
      createdGuardUsers.delete(path);
      await bestEffort(console.warn, `sandbox guard cleanup ${path}`, rmdir(path), undefined);
    }
  });
}

async function realDirectory(path:string, label:string):Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label}_must_be_absolute`);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label}_must_be_a_real_directory`);
  return realpath(path);
}

/** The command was killed at its time limit: reported as 124 like timeout(1), so a caller can tell it from a failure. */
const timedOut=(child:{error?:Error})=>(child.error as NodeJS.ErrnoException|undefined)?.code==="ETIMEDOUT";

export async function runSandboxedCommandOnHost(input:SandboxedCommandInput):Promise<SandboxedCommandResult> {
  const requestedBackend=input.backend ?? "auto";
  const seatbeltAvailable=await access(SANDBOX_EXEC).then(()=>true,()=>false);
  const bubblewrapPath=await Promise.all(BWRAP_CANDIDATES.map(async (path)=>await access(path).then(()=>path,()=>null))).then((paths)=>paths.find(Boolean) ?? null);
  const backend=resolveSandboxBackend(requestedBackend,process.platform,seatbeltAvailable,Boolean(bubblewrapPath));
  const workspacePath = await realDirectory(input.workspacePath,"sandbox_workspace");
  const cwd = await realDirectory(input.cwd,"sandbox_cwd");
  if (!within(workspacePath,cwd)) throw new Error("sandbox_cwd_outside_workspace");
  if (!input.command.trim() || input.command.length > 32_000 || input.command.includes("\0")) throw new Error("sandbox_command_invalid_or_too_large");
  const timeoutSec = input.timeoutSec ?? 120;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 7200) throw new Error("sandbox_timeout_out_of_range");
  // macOS tmpdir() sits under the /var -> /private/var symlink and seatbelt matches real paths,
  // so an unresolved temp path would leave the sandbox's own HOME unwritable.
  const tempPath = await realpath(await mkdtemp(resolve(tmpdir(),"lane-pilot-sandbox-")));
  await linkUserToolHomes(tempPath);
  // Checks as the worker: probe first, then rights on exactly the run folder and this job's temp folder (the job spool).
  if (input.asUser) {
    if (!await workerReachable(input.asUser)) {
      await rm(tempPath,{recursive:true,force:true});
      throw new Error(`worker_unreachable: sudo cannot run as ${input.asUser} without a password; an admin runs scripts/lp-worker-user.sh create ${input.asUser} on this machine, or worker.strict_user goes off`);
    }
    await grantRunFolders(input.asUser,[workspacePath,tempPath]);
  }
  const launch=(program:string,args:string[],keep:string[])=>input.asUser ? asWorker(input.asUser,program,args,keep) : { program, args };
  let releaseGuards=async():Promise<void>=>{};
  const rootsBefore=input.protectedRoots ? await protectedRootsManifest(workspacePath) : null;
  const rootsAfter=async():Promise<SandboxedCommandResult["rootsManifest"]>=>{
    if (!rootsBefore) return undefined;
    const after=await protectedRootsManifest(workspacePath);
    const partial=rootsBefore.partial||after.partial;
    return { before:rootsBefore.sha256, after:after.sha256, changed:!partial&&rootsBefore.sha256!==after.sha256, partial, git:after.git };
  };
  const credentialMask=credentialMaskPaths();
  try {
    if (backend === "linux-bubblewrap") {
      const {guardPaths,created}=await prepareGuardPaths(workspacePath);
      releaseGuards=()=>releaseGuardPaths(created);
      // Secrets travel in bwrap's own environment, never in its arguments (a process list shows those); without --clearenv
      // the sandbox keeps exactly them plus the variables --setenv gives it.
      const secrets=sandboxSecretEnv(input.env);
      const args=buildBubblewrapArgs({workspacePath,cwd,tempPath,guardPaths,credentialMask});
      const policySha256=sha256Hex(JSON.stringify(args));
      const bw=launch(bubblewrapPath!,[...(Object.keys(secrets).length?args.filter((arg)=>arg!=="--clearenv"):args),input.command],Object.keys(secrets));
      const child=await spawnAsync(bw.program,bw.args,{
        cwd,env:secrets,timeout:Math.min(timeoutSec * 1000,MAX_TIMEOUT_MS),keepEnds:KEEP_STDOUT,
      });
      if (child.error && ["EPERM","EACCES","ENOENT"].includes(String((child.error as NodeJS.ErrnoException).code))) {
        throw new Error("sandbox_backend_unavailable: bubblewrap launch was denied or executable is missing");
      }
      return {hostId:process.env.BB_HOST_ID ?? input.requestedHostId,backend,workspacePath,cwd,exitCode:child.status ?? (timedOut(child) ? 124 : 1),
        policySha256,rootsManifest:await rootsAfter(),stdout:maskSecrets(child.stdout ?? "",secrets),stderr:maskSecrets(keepEnds(child.stderr ?? child.error?.message ?? "",KEEP_STDERR),secrets)};
    }
    const profile = buildSeatbeltProfile(workspacePath,tempPath,credentialMask);
    const policySha256 = sha256Hex(profile);
    const seatbeltSecrets=sandboxSecretEnv(input.env);
    const sb=launch(SANDBOX_EXEC,["-p",profile,"/bin/bash","--noprofile","--norc","-c",input.command],[...Object.keys(seatbeltSecrets),"PATH","HOME","TMPDIR","TMP","TEMP","BB_DATA_DIR","LANG","LC_ALL"]);
    const child = await spawnAsync(sb.program,sb.args,{
      cwd,group:true,
      env:{
        // Secrets first: the sandbox's own variables below always win.
        ...seatbeltSecrets,
        PATH:sandboxPath("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"),
        HOME:tempPath,TMPDIR:tempPath,TMP:tempPath,TEMP:tempPath,BB_DATA_DIR:bbDataDir(),
        LANG:"C",LC_ALL:"C",
      },
      timeout:Math.min(timeoutSec * 1000,MAX_TIMEOUT_MS),keepEnds:KEEP_STDOUT,
    });
    if (child.error && ["EPERM","EACCES","ENOENT"].includes(String((child.error as NodeJS.ErrnoException).code))) {
      throw new Error("sandbox_backend_unavailable: Seatbelt launch was denied by the host");
    }
    if (child.status === 71 && /sandbox_apply:.*operation not permitted/i.test(child.stderr ?? "")) {
      throw new Error("sandbox_backend_unavailable: Seatbelt policy could not be applied by the host");
    }
    return {
      hostId:process.env.BB_HOST_ID ?? input.requestedHostId,backend,workspacePath,cwd,
      exitCode:child.status ?? (timedOut(child) ? 124 : 1),policySha256,rootsManifest:await rootsAfter(),
      stdout:maskSecrets(child.stdout ?? "",seatbeltSecrets),stderr:maskSecrets(keepEnds(child.stderr ?? child.error?.message ?? "",KEEP_STDERR),seatbeltSecrets),
    };
  } finally {
    await releaseGuards();
    await rm(tempPath,{recursive:true,force:true});
  }
}

const shellQuote=(value:string)=>`'${value.replace(/'/g,"'\\''")}'`;

export type SandboxedCommandLine = {
  hostId:string; backend:"macos-seatbelt"|"linux-bubblewrap"; workspacePath:string; cwd:string; policySha256:string;
  commandLine:string; cleanup:{tempPath:string; created:string[]};
};

/**
 * The same sandbox as runSandboxedCommandOnHost, as one shell line for a BB terminal: the check then runs where the
 * owner can open and watch it, and BB reports its output and exit code. The caller releases it with
 * releaseSandboxedCommandLine once the terminal has exited.
 */
/**
 * Words that hand the named variables from the terminal's shell into the sandbox: `${NAME+"NAME=$NAME"}` is one
 * word when NAME is set and nothing when it is not, in bash and zsh alike. Only names travel; values stay in the
 * shell that BB started, so they never pass through Lane Pilot or its logs.
 */
export function passEnvWords(names:readonly string[]):string[] {
  return [...new Set(names)].filter((name)=>/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)&&!SANDBOX_OWN_ENV.has(name))
    .map((name)=>`\${${name}+"${name}=$${name}"}`);
}

export async function prepareSandboxedCommandLine(input:SandboxedCommandInput & {passEnv?:string[]}):Promise<SandboxedCommandLine> {
  const passed=passEnvWords(input.passEnv??[]);
  const requestedBackend=input.backend ?? "auto";
  const seatbeltAvailable=await access(SANDBOX_EXEC).then(()=>true,()=>false);
  const bubblewrapPath=await Promise.all(BWRAP_CANDIDATES.map(async (path)=>await access(path).then(()=>path,()=>null))).then((paths)=>paths.find(Boolean) ?? null);
  const backend=resolveSandboxBackend(requestedBackend,process.platform,seatbeltAvailable,Boolean(bubblewrapPath));
  const workspacePath = await realDirectory(input.workspacePath,"sandbox_workspace");
  const cwd = await realDirectory(input.cwd,"sandbox_cwd");
  if (!within(workspacePath,cwd)) throw new Error("sandbox_cwd_outside_workspace");
  if (!input.command.trim() || input.command.length > 32_000 || input.command.includes("\0")) throw new Error("sandbox_command_invalid_or_too_large");
  const tempPath = await realpath(await mkdtemp(resolve(tmpdir(),"lane-pilot-sandbox-")));
  await linkUserToolHomes(tempPath);
  const hostId=process.env.BB_HOST_ID ?? input.requestedHostId;
  if (backend === "linux-bubblewrap") {
    const {guardPaths,created}=await prepareGuardPaths(workspacePath);
    const args=buildBubblewrapArgs({workspacePath,cwd,tempPath,guardPaths,credentialMask:credentialMaskPaths()});
    const policySha256=sha256Hex(JSON.stringify(args));
    // With variables to pass, `env -i` starts bwrap with only those, instead of bwrap's --clearenv; the sandbox's
    // own PATH, HOME and temp folders are still set by --setenv and win.
    const bwrapLine=[bubblewrapPath!,...(passed.length?args.filter((arg)=>arg!=="--clearenv"):args),input.command].map(shellQuote).join(" ");
    return {hostId,backend,workspacePath,cwd,policySha256,cleanup:{tempPath,created},
      commandLine:passed.length?`exec /usr/bin/env -i ${passed.join(" ")} ${bwrapLine}`:`exec ${bwrapLine}`};
  }
  const profile = buildSeatbeltProfile(workspacePath,tempPath,credentialMaskPaths());
  const policySha256 = sha256Hex(profile);
  const env = [`PATH=${sandboxPath("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")}`,`HOME=${tempPath}`,`TMPDIR=${tempPath}`,`TMP=${tempPath}`,`TEMP=${tempPath}`,`BB_DATA_DIR=${bbDataDir()}`,"LANG=C","LC_ALL=C"];
  return {hostId,backend,workspacePath,cwd,policySha256,cleanup:{tempPath,created:[]},
    // Passed variables come before the sandbox's own, so PATH, HOME and the temp folders always win.
    commandLine:`cd ${shellQuote(cwd)} && exec /usr/bin/env -i ${[...passed,...[...env,SANDBOX_EXEC,"-p",profile,"/bin/bash","--noprofile","--norc","-c",input.command].map(shellQuote)].join(" ")}`};
}

export async function releaseSandboxedCommandLine(cleanup:{tempPath:string;created:string[]}):Promise<void> {
  // Only Lane Pilot's own sandbox temp folders are removed.
  if (!/\/lane-pilot-sandbox-[^/]+$/.test(cleanup.tempPath)) throw new Error("sandbox_release_refused");
  await releaseGuardPaths(cleanup.created);
  await rm(cleanup.tempPath,{recursive:true,force:true});
}
