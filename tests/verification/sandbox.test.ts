import { describe, expect, it } from "vitest";
import { buildBubblewrapArgs, buildSeatbeltProfile, resolveSandboxBackend } from "../../src/verification/sandbox";
import { hostContract } from "../../src/contracts";
import { validateSettingValue } from "../../src/setting-validation";

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
  it("allows writes only in the selected workspace and temporary scope, while denying network and protected state", () => {
    const profile = buildSeatbeltProfile("/tmp/lane-worktree","/private/tmp/lane-temp");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain('(deny file-write* (require-all (require-not (subpath "/tmp/lane-worktree")) (require-not (subpath "/private/tmp/lane-temp")) (require-not (literal "/dev/null"))))');
    expect(profile).toContain('(deny file-write* (subpath "/tmp/lane-worktree/.git"))');
    expect(profile).toContain('(deny file-write* (subpath "/tmp/lane-worktree/.agents"))');
    expect(profile).toContain('(deny file-write* (subpath "/tmp/lane-worktree/.cls"))');
    expect(profile).toContain("(deny network*)");
  });

  it("rejects SBPL path delimiters rather than interpolating profile syntax", () => {
    expect(() => buildSeatbeltProfile('/tmp/work")(allow default)',"/tmp/temp")).toThrow();
    expect(() => buildSeatbeltProfile("relative-workspace","/tmp/temp")).toThrow();
  });

  it("builds bubblewrap argv with isolated namespaces and read-only root/guard binds",()=>{
    const args=buildBubblewrapArgs({workspacePath:"/work",cwd:"/work/project",tempPath:"/tmp/lp",guardPaths:["/work/.git","/work/.agents","/work/.cls"]});
    expect(args).toEqual(expect.arrayContaining(["--unshare-all","--ro-bind","/","/","--bind","/work","/work","--ro-bind","/work/.git","/work/.git","--chdir","/work/project","--clearenv","--setenv","HOME","/tmp/lp","--","/bin/bash","--noprofile","--norc","-c"]));
    expect(args).not.toContain("--share-net");
  });

  it("accepts the Linux backend at both project-setting and host RPC boundaries",()=>{
    expect(validateSettingValue("sandbox.backend","linux-bubblewrap")).toBeNull();
    const input=hostContract.runSandboxedCommand.input.parse({requestedHostId:"host-test",workspacePath:"/work",cwd:"/work",backend:"linux-bubblewrap",command:"true"});
    expect(input.backend).toBe("linux-bubblewrap");
    expect(hostContract.runSandboxedCommand.output.parse({hostId:"host-test",backend:"linux-bubblewrap",workspacePath:"/work",cwd:"/work",exitCode:0,policySha256:"a".repeat(64),stdout:"",stderr:""}).backend).toBe("linux-bubblewrap");
    expect(()=>hostContract.runSandboxedCommand.input.parse({requestedHostId:"host-test",workspacePath:"/work",cwd:"/work",backend:"unsupported",command:"true"})).toThrow();
  });
});
