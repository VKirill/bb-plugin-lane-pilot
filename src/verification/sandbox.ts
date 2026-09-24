import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
    "(deny network*)",
    `(deny file-write* (require-all (require-not (subpath ${workspace})) (require-not (subpath ${temporary})) (require-not (literal \"/dev/null\"))))`,
    denyWrites,
  ].join("\n");
}

/** Build an argv-only bubblewrap policy. Sensitive workspace entries must exist so they can be bind-mounted read-only. */
export function buildBubblewrapArgs(input:{workspacePath:string;cwd:string;tempPath:string;guardPaths:string[]}):string[] {
  const args=["--die-with-parent","--new-session","--unshare-all","--ro-bind","/","/","--bind",input.workspacePath,input.workspacePath];
  for (const guardPath of input.guardPaths) args.push("--ro-bind",guardPath,guardPath);
  args.push("--bind",input.tempPath,input.tempPath,"--proc","/proc","--dev","/dev","--chdir",input.cwd,
    "--clearenv","--setenv","PATH","/usr/local/bin:/usr/bin:/bin","--setenv","HOME",input.tempPath,
    "--setenv","TMPDIR",input.tempPath,"--setenv","TMP",input.tempPath,"--setenv","TEMP",input.tempPath,
    "--setenv","LANG","C","--setenv","LC_ALL","C","--","/bin/bash","--noprofile","--norc","-c");
  return args;
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
  const tempPath = await mkdtemp(resolve(tmpdir(),"lane-pilot-sandbox-"));
  try {
    if (backend === "linux-bubblewrap") {
      const guardPaths:string[]=[];
      for (const name of [".git",".agents",".cls"]) {
        const guardPath=resolve(workspacePath,name);
        let info;
        try { info=await lstat(guardPath); } catch { throw new Error(`sandbox_guard_path_missing: ${name}; refusing to expose it writable`); }
        if (info.isSymbolicLink()) throw new Error(`sandbox_guard_path_symlink: ${name}; refusing to expose it writable`);
        guardPaths.push(guardPath);
      }
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
        PATH:"/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
        HOME:tempPath,TMPDIR:tempPath,TMP:tempPath,TEMP:tempPath,
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
    await rm(tempPath,{recursive:true,force:true});
  }
}
