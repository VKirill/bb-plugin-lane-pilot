import { accessSync, constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, realpath, rm, rmdir } from "node:fs/promises";
import { request as httpRequest, createServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../redact";
import { spawnAsync } from "../spawn-async";

export type SandboxedCommandInput = {
  requestedHostId:string; workspacePath:string; cwd:string; command:string; backend?:"auto"|"macos-seatbelt"|"linux-bubblewrap"; timeoutSec?:number;
  /** Secret values for this command (Env Catalog): set in its environment, masked in what it printed. */
  env?:Record<string,string>;
  /**
   * A command given `env` has no network beyond localhost. These hosts (owner-approved) are the exception where the
   * backend can filter by host: macOS, through a local proxy that allows only them. Bubblewrap cannot, so there the
   * command has no network at all.
   */
  networkHosts?:readonly string[];
};
export type SandboxedCommandResult = {
  hostId:string; backend:"macos-seatbelt"|"linux-bubblewrap"; workspacePath:string; cwd:string; exitCode:number;
  policySha256:string; stdout:string; stderr:string;
};

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const SANDBOX_OWN_ENV=new Set(["PATH","HOME","TMPDIR","TMP","TEMP","LANG","LC_ALL"]);
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

/** What a command's network is: open (checks without secrets), or localhost only (checks that carry secrets). */
export type SandboxNetwork = "open"|"loopback";

export function buildSeatbeltProfile(workspacePath:string, tempPath:string, network:SandboxNetwork="open"):string {
  const workspace = sbplPath(workspacePath);
  const temporary = sbplPath(tempPath);
  const denyWrites = [".git", ".agents", ".cls"].map((name) => `(deny file-write* (subpath ${sbplPath(resolve(workspacePath,name))}))`).join("\n");
  return [
    "(version 1)",
    "(allow default)",
    // Network stays open for a check without secrets: checks such as curl against a dev server or an API must be able to pass.
    // A check that carries secrets keeps localhost only: code from the writer could otherwise send the secret out. The deny
    // also stops name lookups and UDP (verified on macOS: no DNS, no direct IP). One `(allow network* (local ip "localhost:*"))` looked the same but let every address out, so the three operations are listed apart.
    ...(network === "loopback" ? ["(deny network*)",'(allow network-bind (local ip "localhost:*"))','(allow network-inbound (local ip "localhost:*"))','(allow network-outbound (remote ip "localhost:*"))'] : []),
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

export function buildBubblewrapArgs(input:{workspacePath:string;cwd:string;tempPath:string;guardPaths:string[];network?:SandboxNetwork}):string[] {
  // --share-net keeps the host network while every other namespace stays private: a check may curl a dev
  // server or an API, but still writes only into the workspace and its temp folder. Before, --unshare-all
  // alone cut the network, so no curl verification could ever pass.
  // A command that carries secrets keeps the private network namespace (--unshare-all): only its own loopback, no host filter possible.
  const args=["--die-with-parent","--new-session","--unshare-all",...(input.network === "loopback" ? [] : ["--share-net"]),"--ro-bind","/","/","--bind",input.workspacePath,input.workspacePath];
  for (const guardPath of input.guardPaths) args.push("--ro-bind",guardPath,guardPath);
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

/** Whether a declared host pattern (`api.x.com`, or `*.x.com` for its subdomains) covers a requested host. */
export function networkHostAllowed(hosts:readonly string[],requested:string):boolean {
  const host=requested.toLowerCase().replace(/\.$/,"");
  return hosts.some((entry)=>{
    const pattern=entry.toLowerCase();
    return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length>pattern.length-1 : host===pattern;
  });
}

const PROXY_PORTS=new Set([80,443]);

/**
 * A local forward proxy that lets a sandboxed command reach only the hosts it was approved for (ports 80 and 443). The
 * sandbox allows localhost only, so a program that ignores the proxy variables simply has no network; one that follows
 * them (curl, npm, pip, git, python requests, node with NODE_USE_ENV_PROXY) reaches the approved hosts and nothing else.
 */
export async function startAllowListProxy(hosts:readonly string[],ports:ReadonlySet<number>=PROXY_PORTS):Promise<{port:number;close:()=>Promise<void>}> {
  const sockets=new Set<Socket>();
  const track=(socket:Socket)=>{ sockets.add(socket); socket.on("close",()=>sockets.delete(socket)); socket.on("error",()=>undefined); };
  const server:Server=createServer((req,res)=>{
    let target:URL;
    try { target=new URL(req.url ?? ""); } catch { res.writeHead(400).end(); return; }
    const port=Number(target.port||80);
    if (target.protocol!=="http:" || !networkHostAllowed(hosts,target.hostname) || !ports.has(port)) { res.writeHead(403).end("lane-pilot: host not approved for this check"); return; }
    const upstream=httpRequest({host:target.hostname,port,method:req.method,path:`${target.pathname}${target.search}`,headers:req.headers},(reply)=>{ res.writeHead(reply.statusCode ?? 502,reply.headers); reply.pipe(res); });
    upstream.on("error",()=>{ if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on("connection",track);
  server.on("connect",(req,client:Socket,head)=>{
    const [host="",portText="443"]=(req.url ?? "").split(":");
    const port=Number(portText);
    if (!networkHostAllowed(hosts,host) || !ports.has(port)) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const upstream=netConnect(port,host,()=>{ client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
    track(upstream);
    upstream.on("error",()=>client.destroy());
    client.on("error",()=>upstream.destroy());
  });
  await new Promise<void>((done,fail)=>{ server.once("error",fail); server.listen(0,"127.0.0.1",()=>done()); });
  const port=(server.address() as {port:number}).port;
  return {port,close:()=>new Promise<void>((done)=>{ for (const socket of sockets) socket.destroy(); server.close(()=>done()); })};
}

const proxyEnv=(port:number):Record<string,string>=>{
  const url=`http://127.0.0.1:${port}`;
  return {HTTP_PROXY:url,HTTPS_PROXY:url,ALL_PROXY:url,http_proxy:url,https_proxy:url,all_proxy:url,NO_PROXY:"localhost,127.0.0.1",no_proxy:"localhost,127.0.0.1",NODE_USE_ENV_PROXY:"1"};
};

/** Said on a failed check that carried secrets, so the writer and the PM do not read a blocked connection as a bug in the code. */
function networkNote(backend:"macos-seatbelt"|"linux-bubblewrap",hosts:readonly string[]):string {
  if (backend==="linux-bubblewrap") return `\n[lane-pilot] this check carries secrets, so it ran with no network beyond localhost${hosts.length?` (bubblewrap cannot filter by host: ${hosts.join(", ")} was not reachable)`:""}.`;
  return `\n[lane-pilot] this check carries secrets, so its network is limited to localhost${hosts.length?` and ${hosts.join(", ")} (ports 80 and 443, through a proxy: the tool must honour HTTP_PROXY/HTTPS_PROXY)`:"; declare the hosts it needs in the check's `network` list"}.`;
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
  let releaseGuards=async():Promise<void>=>{};
  try {
    if (backend === "linux-bubblewrap") {
      const {guardPaths,created}=await prepareGuardPaths(workspacePath);
      releaseGuards=()=>releaseGuardPaths(created);
      // Secrets travel in bwrap's own environment, never in its arguments (a process list shows those); without --clearenv
      // the sandbox keeps exactly them plus the variables --setenv gives it.
      const secrets=sandboxSecretEnv(input.env);
      const carriesSecrets=Object.keys(secrets).length>0;
      const args=buildBubblewrapArgs({workspacePath,cwd,tempPath,guardPaths,network:carriesSecrets?"loopback":"open"});
      const policySha256=createHash("sha256").update(JSON.stringify(args),"utf8").digest("hex");
      const child=await spawnAsync(bubblewrapPath!,[...(Object.keys(secrets).length?args.filter((arg)=>arg!=="--clearenv"):args),input.command],{
        cwd,env:secrets,timeout:Math.min(timeoutSec * 1000,MAX_TIMEOUT_MS),maxBuffer:MAX_OUTPUT,
      });
      if (child.error && ["EPERM","EACCES","ENOENT"].includes(String((child.error as NodeJS.ErrnoException).code))) {
        throw new Error("sandbox_backend_unavailable: bubblewrap launch was denied or executable is missing");
      }
      const exitCode=child.status ?? (timedOut(child) ? 124 : 1);
      return {hostId:process.env.BB_HOST_ID ?? input.requestedHostId,backend,workspacePath,cwd,exitCode,
        policySha256,stdout:maskSecrets((child.stdout ?? "").slice(0,200_000),secrets),
        stderr:maskSecrets((child.stderr ?? child.error?.message ?? "").slice(0,12_000),secrets)+(carriesSecrets&&exitCode!==0?networkNote(backend,input.networkHosts ?? []):"")};
    }
    const seatbeltSecrets=sandboxSecretEnv(input.env);
    const carriesSecrets=Object.keys(seatbeltSecrets).length>0;
    const hosts=carriesSecrets ? [...(input.networkHosts ?? [])] : [];
    const profile = buildSeatbeltProfile(workspacePath,tempPath,carriesSecrets?"loopback":"open");
    const policySha256 = createHash("sha256").update(hosts.length ? `${profile}\n;hosts ${hosts.join(",")}` : profile,"utf8").digest("hex");
    const proxy=hosts.length?await startAllowListProxy(hosts):null;
    try {
    const child = await spawnAsync(SANDBOX_EXEC,["-p",profile,"/bin/bash","--noprofile","--norc","-c",input.command],{
      cwd,
      env:{
        // Secrets first: the sandbox's own variables below always win.
        ...seatbeltSecrets,
        ...(proxy?proxyEnv(proxy.port):{}),
        PATH:sandboxPath("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"),
        HOME:tempPath,TMPDIR:tempPath,TMP:tempPath,TEMP:tempPath,BB_DATA_DIR:bbDataDir(),
        LANG:"C",LC_ALL:"C",
      },
      timeout:Math.min(timeoutSec * 1000,MAX_TIMEOUT_MS),maxBuffer:MAX_OUTPUT,
    });
    if (child.error && ["EPERM","EACCES","ENOENT"].includes(String((child.error as NodeJS.ErrnoException).code))) {
      throw new Error("sandbox_backend_unavailable: Seatbelt launch was denied by the host");
    }
    if (child.status === 71 && /sandbox_apply:.*operation not permitted/i.test(child.stderr ?? "")) {
      throw new Error("sandbox_backend_unavailable: Seatbelt policy could not be applied by the host");
    }
    const exitCode=child.status ?? (timedOut(child) ? 124 : 1);
    return {
      hostId:process.env.BB_HOST_ID ?? input.requestedHostId,backend,workspacePath,cwd,
      exitCode,policySha256,
      stdout:maskSecrets((child.stdout ?? "").slice(0,200_000),seatbeltSecrets),
      stderr:maskSecrets((child.stderr ?? child.error?.message ?? "").slice(0,12_000),seatbeltSecrets)+(carriesSecrets&&exitCode!==0?networkNote(backend,hosts):""),
    };
    } finally { await proxy?.close(); }
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
