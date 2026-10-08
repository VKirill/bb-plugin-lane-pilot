import { describe, expect, it } from "vitest";
import { bbDataDir, buildBubblewrapArgs, buildSeatbeltProfile, passEnvWords, prepareSandboxedCommandLine, releaseSandboxedCommandLine, resolveSandboxBackend } from "../../src/rooms/verification/sandbox";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostContract } from "../../src/contracts";
import { validateSettingValue } from "../../src/rooms/settings/setting-validation";

describe("host sandbox policy", () => {
  it("resolves auto only to the verified native backend and fails closed for unsupported hosts or backends", () => {
    expect(resolveSandboxBackend("auto","darwin",true)).toBe("macos-seatbelt");
    expect(resolveSandboxBackend("macos-seatbelt","darwin",true)).toBe("macos-seatbelt");
    expect(resolveSandboxBackend("auto","linux",false,true)).toBe("linux-bubblewrap");
    expect(resolveSandboxBackend("linux-bubblewrap","linux",false,true)).toBe("linux-bubblewrap");
    expect(() => resolveSandboxBackend("auto","linux",false,false)).toThrow("sandbox_backend_unavailable");
    expect(() => resolveSandboxBackend("macos-seatbelt","darwin",false)).toThrow("sandbox_backend_unavailable");
    expect(() => resolveSandboxBackend("linux-bubblewrap","darwin",false,true)).toThrow("sandbox_backend_unavailable");
  });
  it("allows writes only in the selected workspace and temporary scope and denies protected state, with network open", () => {
    const profile = buildSeatbeltProfile("/tmp/lane-worktree","/private/tmp/lane-temp");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain('(deny file-write* (require-all (require-not (subpath "/tmp/lane-worktree")) (require-not (subpath "/private/tmp/lane-temp")) (require-not (literal "/dev/null"))))');
    expect(profile).toContain('(deny file-write* (subpath "/tmp/lane-worktree/.git"))');
    expect(profile).toContain('(deny file-write* (subpath "/tmp/lane-worktree/.agents"))');
    expect(profile).toContain('(deny file-write* (subpath "/tmp/lane-worktree/.cls"))');
    expect(profile).not.toContain("(deny network*)");
  });

  it("rejects SBPL path delimiters rather than interpolating profile syntax", () => {
    expect(() => buildSeatbeltProfile('/tmp/work")(allow default)',"/tmp/temp")).toThrow();
    expect(() => buildSeatbeltProfile("relative-workspace","/tmp/temp")).toThrow();
  });

  it("builds bubblewrap argv with isolated namespaces and read-only root/guard binds",()=>{
    const args=buildBubblewrapArgs({workspacePath:"/work",cwd:"/work/project",tempPath:"/tmp/lp",guardPaths:["/work/.git","/work/.agents","/work/.cls"]});
    expect(args.slice(2, 4)).toEqual(["--unshare-all","--share-net"]);
    expect(args).toEqual(expect.arrayContaining(["--unshare-all","--ro-bind","/","/","--bind","/work","/work","--ro-bind","/work/.git","/work/.git","--chdir","/work/project","--clearenv","--setenv","HOME","/tmp/lp","--","/bin/bash","--noprofile","--norc","-c"]));
    expect(args).toContain("--share-net");
  });

  it("points bb at the real BB data folder, so `bb plugin build` finds its toolchain while HOME is the temp folder",async()=>{
    expect(bbDataDir({BB_DATA_DIR:"/data/bb"})).toBe("/data/bb");
    expect(bbDataDir({})).toMatch(/\/\.bb$/);
    const args=buildBubblewrapArgs({workspacePath:"/work",cwd:"/work",tempPath:"/tmp/lp",guardPaths:[]});
    expect(args.join(" ")).toContain(`--setenv BB_DATA_DIR ${bbDataDir()}`);
    const workspace=realpathSync(mkdtempSync(join(tmpdir(),"lp-bbdata-")));
    const line=await prepareSandboxedCommandLine({requestedHostId:"h",workspacePath:workspace,cwd:workspace,command:"true"});
    try { if(line.backend==="macos-seatbelt") expect(line.commandLine).toContain(`BB_DATA_DIR=${bbDataDir()}`); }
    finally { await releaseSandboxedCommandLine(line.cleanup); }
  });

  it("accepts the Linux backend at both project-setting and host RPC boundaries",()=>{
    expect(validateSettingValue("sandbox.backend","linux-bubblewrap")).toBeNull();
    const input=hostContract.runSandboxedCommand.input.parse({requestedHostId:"host-test",workspacePath:"/work",cwd:"/work",backend:"linux-bubblewrap",command:"true"});
    expect(input.backend).toBe("linux-bubblewrap");
    expect(hostContract.runSandboxedCommand.output.parse({hostId:"host-test",backend:"linux-bubblewrap",workspacePath:"/work",cwd:"/work",exitCode:0,policySha256:"a".repeat(64),stdout:"",stderr:""}).backend).toBe("linux-bubblewrap");
    expect(()=>hostContract.runSandboxedCommand.input.parse({requestedHostId:"host-test",workspacePath:"/work",cwd:"/work",backend:"unsupported",command:"true"})).toThrow();
  });
  it("passes project variables by name only, never the sandbox's own ones or invalid names",()=>{
    expect(passEnvWords(["API_KEY","PATH","HOME","bad-name","API_KEY","A1"])).toEqual(['${API_KEY+"API_KEY=$API_KEY"}','${A1+"A1=$A1"}']);
  });

  it.runIf(process.platform==="darwin")("hands a set variable into the macOS sandbox and leaves an unset one out",async ()=>{
    const workspace=realpathSync(mkdtempSync(join(tmpdir(),"lp-passenv-")));
    const line=await prepareSandboxedCommandLine({requestedHostId:"h",workspacePath:workspace,cwd:workspace,
      command:'printf "%s|%s|%s" "${LP_SET-}" "${LP_UNSET-unset}" "$HOME"',passEnv:["LP_SET","LP_UNSET","HOME"]});
    try {
      const out=execFileSync("/bin/zsh",["-c",line.commandLine],{encoding:"utf8",env:{...process.env,LP_SET:"a b$c",LP_UNSET:undefined}});
      expect(out).toBe(`a b$c|unset|${line.cleanup.tempPath}`);
    } finally { await releaseSandboxedCommandLine(line.cleanup); }
  });
});
