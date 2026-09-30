import { mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const upstream = join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack/hooks/guard_shell.py");
const cwd = join(process.cwd(), "tests/guard-fixture");
mkdirSync(cwd, {recursive:true});

type Case = { name:string; tool:string; input:Record<string,unknown>; allowed:boolean };
const bash = (name:string, command:string, allowed:boolean): Case => ({name,tool:"Bash",input:{command},allowed});
const edit = (name:string, tool:string, file_path:string, allowed:boolean): Case => ({name,tool,input:{file_path},allowed});

const cases: Case[] = [
  bash("git status","git status",true),
  bash("ls runs","ls -la .agents/runs",true),
  bash("adoc json","adoc . --json",true),
  bash("lane ctl status","lane-ctl status --run-dir .agents/runs/r1",true),
  // Writers are BB threads in a Lane Pilot chat, so the old lane controller stays closed.
  bash("controller watch","run-controller watch --run-dir .agents/runs/r1",false),
  // The PM's shell follows a plain claude-lane chat: project scripts, deploys and git work pass.
  bash("bash c mutate","bash -c 'git add . && git commit -m x'",true),
  bash("bash c read","bash -c 'ls .agents'",true),
  bash("bash script","bash scripts/mutate-production.sh",true),
  bash("sh script","sh ./deploy-overwrite.sh",true),
  bash("python script","python3 scripts/mutate.py",true),
  bash("node script","node scripts/mutate.js",true),
  ...["add .","commit -m x","merge branch","push","rebase main","reset --hard","stash","cherry-pick abc","checkout -b x","apply x.patch","am x.patch","pull"].map((tail) => bash(`git ${tail}`,`git ${tail}`,true)),
  bash("redirect production","echo x > src/production.ts",true),
  bash("redirect temp","echo x > /tmp/lane-pilot-test.log",true),
  bash("tee production","git log | tee src/production.ts",true),
  bash("tee temp","git log | tee /tmp/x.log",true),
  ...["Edit","Write","MultiEdit","NotebookEdit"].map((tool) => edit(`${tool} production`,tool,"src/app.ts",false)),
  ...["Edit","Write","MultiEdit","NotebookEdit"].flatMap((tool) => [
    edit(`${tool} progress`,tool,".agents/PROGRESS.md",true),
    edit(`${tool} plan`,tool,"docs/plans/x.md",true),
  ]),
  ...["Edit","Write","MultiEdit","NotebookEdit"].map((tool) => edit(`${tool} receipt`,tool,".agents/runs/r1/controller.json",false)),
  bash("adoc apply","adoc . --apply --writer-provider claude",true),
];

function invoke(path:string, testCase:Case) {
  return spawnSync("python3", [path], {
    input:JSON.stringify({
      agent_type:"lane-pilot-pm",
      tool_name:testCase.tool,
      tool_input:testCase.input,
      cwd,
    }),
    encoding:"utf8",
    env:{...process.env,AGENT_HOOK_CLIENT:"claude"},
  });
}

describe("E2 Lane Pilot PM guard", () => {
  it("keeps the normative table at 44 cases", () => expect(cases).toHaveLength(44));
  for (const testCase of cases) {
    it(`${testCase.name}: ${testCase.allowed ? "allow" : "deny"}`, () => {
      const result = invoke(guard,testCase);
      expect(result.status, result.stdout + result.stderr).toBe(testCase.allowed ? 0 : 2);
      if (!testCase.allowed) expect(result.stdout).toContain('"decision": "block"');
    });
  }

  it("still blocks the destructive commands a plain claude-lane chat blocks", () => {
    const probes = [
      "rm -rf src",
      "git push " + "--" + "force origin main",
      "git commit --no-verify -m x",
      "psql -c 'DROP TABLE users'",
      "./scripts/deploy.sh && run-controller start --run-dir .agents/runs/r1",
    ];
    for (const [index, command] of probes.entries()) {
      const result = invoke(guard,bash(`destructive-${index+1}`,command,false));
      expect(result.status, `${command}\n${result.stdout}${result.stderr}`).toBe(2);
    }
  });

  it("lets the PM deploy the way the user's own chat does", () => {
    for (const command of [
      "cd /srv/app && ./scripts/deploy.sh --base abc",
      "sudo -n env PATH=/usr/bin:/bin ./scripts/deploy.sh --base abc",
      "docker compose up -d api",
      "npm run verify:api",
      "systemctl --user restart app",
    ]) {
      expect(invoke(guard,bash("ops",command,true)).status, command).toBe(0);
    }
  });

  it("treats Claude agentSetting namespace as the same PM identity", () => {
    const namespaced = JSON.stringify({
      agent_type: "lane-stack:dev-orchestrator",
      tool_name: "Write",
      tool_input: { file_path: "src/app.ts" },
      cwd,
    });
    const short = JSON.stringify({
      agent_type: "dev-orchestrator",
      tool_name: "Write",
      tool_input: { file_path: "src/app.ts" },
      cwd,
    });
    const options = { encoding: "utf8" as const, env: { ...process.env, AGENT_HOOK_CLIENT: "claude" } };
    const a = spawnSync("python3", [guard], { ...options, input: namespaced });
    const b = spawnSync("python3", [guard], { ...options, input: short });
    expect(a.status).toBe(b.status);
    expect(a.status).not.toBe(0);
  });

  it("leaves representative upstream PM_AGENTS behavior byte-for-byte", () => {
    const probes = [
      bash("read","git status",true),
      bash("upstream mutation remains upstream","git add src/app.ts",true),
      bash("sed","sed -i x file",false),
      edit("doc","Edit","docs/plans/x.md",true),
      edit("source","Write","src/app.ts",false),
    ];
    for (const testCase of probes) {
      const payload = JSON.stringify({agent_type:"dev-orchestrator",tool_name:testCase.tool,tool_input:testCase.input,cwd});
      const options = {input:payload,encoding:"utf8" as const,env:{...process.env,AGENT_HOOK_CLIENT:"claude"}};
      const before = spawnSync("python3",[upstream],options);
      const after = spawnSync("python3",[guard],options);
      expect({status:after.status,stdout:after.stdout,stderr:after.stderr})
        .toEqual({status:before.status,stdout:before.stdout,stderr:before.stderr});
    }
  });
});
