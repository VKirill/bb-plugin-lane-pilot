import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, realpath, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type SandboxedCommandInput = {
  requestedHostId:string; workspacePath:string; cwd:string; command:string; backend?:"auto"|"macos-seatbelt"|"linux-bubblewrap"; timeoutSec?:number;
};
export type SandboxedCommandResult = {
  hostId:string; backend:"macos-seatbelt"|"linux-bubblewrap"; workspacePath:string; cwd:string; exitCode:number;
  policySha256:string; stdout:string; stderr:string;
};

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_OUTPUT = 1_000_000;
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

export function buildSeatbeltProfile(workspacePath:string, tempPath:string):string {
  const workspace = sbplPath(workspacePath);
  const temporary = sbplPath(tempPath);
  const denyWrites = [".git", ".agents", ".cls"].map((name) => `(deny file-write* (subpath ${sbplPath(resolve(workspacePath,name))}))`).join("\n");
  return [
    "(version 1)",
    "(allow default)",
    // Network stays open: checks such as curl against a dev server or an API must be able to pass.
    `(deny file-write* (require-all (require-not (subpath ${workspace})) (require-not (subpath ${temporary})) (require-not (literal \"/dev/null\"))))`,
    denyWrites,
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

function sandboxPath(base:string):string {
  const bb = bbCliDir();
  return bb ? `${base}:${bb}` : base;
}

export function buildBubblewrapArgs(input:{workspacePath:string;cwd:string;tempPath:string;guardPaths:string[]}):string[] {
  // --share-net keeps the host network while every other namespace stays private: a check may curl a dev
  // server or an API, but still writes only into the workspace and its temp folder. Before, --unshare-all
  // alone cut the network, so no curl verification could ever pass.
  const args=["--die-with-parent","--new-session","--unshare-all","--share-net","--ro-bind","/","/","--bind",input.workspacePath,input.workspacePath];
  for (const guardPath of input.guardPaths) args.push("--ro-bind",guardPath,guardPath);
  args.push("--bind",input.tempPath,input.tempPath,"--proc","/proc","--dev","/dev","--chdir",input.cwd,
    "--clearenv","--setenv","PATH",sandboxPath("/usr/local/bin:/usr/bin:/bin"),"--setenv","HOME",input.tempPath,
    "--setenv","TMPDIR",input.tempPath,"--setenv","TMP",input.tempPath,"--setenv","TEMP",input.tempPath,
    "--setenv","BB_DATA_DIR",bbDataDir(),"--setenv","LANG","C","--setenv","LC_ALL","C","--","/bin/bash","--noprofile","--norc","-c");
  return args;
}

/** Guard paths the sandbox created, with how many running checks use each; checks of one attempt run at once. */
const createdGuardUsers=new Map<string,number>();
let guardLock:Promise<unknown>=Promise.resolve();

function underGuardLock<T>(work:()=>Promise<T>):Promise<T> {
  const turn=guardLock.then(work);
  guardLock=turn.catch(()=>undefined);
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
        const info=await lstat(guardPath).catch(()=>null);
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
      await rmdir(path).catch(()=>undefined);
    }
  });
}

async function realDirectory(path:string, label:string):Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label}_must_be_absolute`);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label}_must_be_a_real_directory`);
  return realpath(path);
}

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
  let releaseGuards=async():Promise<void>=>{};
  try {
    if (backend === "linux-bubblewrap") {
      const {guardPaths,created}=await prepareGuardPaths(workspacePath);
      releaseGuards=()=>releaseGuardPaths(created);
      const args=buildBubblewrapArgs({workspacePath,cwd,tempPath,guardPaths});
      const policySha256=createHash("sha256").update(JSON.stringify(args),"utf8").digest("hex");
      const child=spawnSync(bubblewrapPath!,[...args,input.command],{
        cwd,env:{},encoding:"utf8",timeout:Math.min(timeoutSec * 1000,MAX_TIMEOUT_MS),maxBuffer:MAX_OUTPUT,
      });
      if (child.error && ["EPERM","EACCES","ENOENT"].includes(String((child.error as NodeJS.ErrnoException).code))) {
        throw new Error("sandbox_backend_unavailable: bubblewrap launch was denied or executable is missing");
      }
      return {hostId:process.env.BB_HOST_ID ?? input.requestedHostId,backend,workspacePath,cwd,exitCode:child.status ?? 1,
        policySha256,stdout:(child.stdout ?? "").slice(0,200_000),stderr:(child.stderr ?? child.error?.message ?? "").slice(0,12_000)};
    }
    const profile = buildSeatbeltProfile(workspacePath,tempPath);
    const policySha256 = createHash("sha256").update(profile,"utf8").digest("hex");
    const child = spawnSync(SANDBOX_EXEC,["-p",profile,"/bin/bash","--noprofile","--norc","-c",input.command],{
      cwd,
      env:{
        PATH:sandboxPath("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"),
        HOME:tempPath,TMPDIR:tempPath,TMP:tempPath,TEMP:tempPath,BB_DATA_DIR:bbDataDir(),
        LANG:"C",LC_ALL:"C",
      },
      encoding:"utf8",timeout:Math.min(timeoutSec * 1000,MAX_TIMEOUT_MS),maxBuffer:MAX_OUTPUT,
    });
    if (child.error && ["EPERM","EACCES","ENOENT"].includes(String((child.error as NodeJS.ErrnoException).code))) {
      throw new Error("sandbox_backend_unavailable: Seatbelt launch was denied by the host");
    }
    if (child.status === 71 && /sandbox_apply:.*operation not permitted/i.test(child.stderr ?? "")) {
      throw new Error("sandbox_backend_unavailable: Seatbelt policy could not be applied by the host");
    }
    return {
      hostId:process.env.BB_HOST_ID ?? input.requestedHostId,backend,workspacePath,cwd,
      exitCode:child.status ?? 1,policySha256,
      stdout:(child.stdout ?? "").slice(0,200_000),stderr:(child.stderr ?? child.error?.message ?? "").slice(0,12_000),
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
const SANDBOX_OWN_ENV=new Set(["PATH","HOME","TMPDIR","TMP","TEMP","LANG","LC_ALL"]);

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
  const hostId=process.env.BB_HOST_ID ?? input.requestedHostId;
  if (backend === "linux-bubblewrap") {
    const {guardPaths,created}=await prepareGuardPaths(workspacePath);
    const args=buildBubblewrapArgs({workspacePath,cwd,tempPath,guardPaths});
    const policySha256=createHash("sha256").update(JSON.stringify(args),"utf8").digest("hex");
    // With variables to pass, `env -i` starts bwrap with only those, instead of bwrap's --clearenv; the sandbox's
    // own PATH, HOME and temp folders are still set by --setenv and win.
    const bwrapLine=[bubblewrapPath!,...(passed.length?args.filter((arg)=>arg!=="--clearenv"):args),input.command].map(shellQuote).join(" ");
    return {hostId,backend,workspacePath,cwd,policySha256,cleanup:{tempPath,created},
      commandLine:passed.length?`exec /usr/bin/env -i ${passed.join(" ")} ${bwrapLine}`:`exec ${bwrapLine}`};
  }
  const profile = buildSeatbeltProfile(workspacePath,tempPath);
  const policySha256 = createHash("sha256").update(profile,"utf8").digest("hex");
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
