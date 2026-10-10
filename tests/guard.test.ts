import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { NO_UPSTREAM, upstreamPath } from "./upstream-fixture";
import { hookEnv } from "./hook-env";
import { useGuardSync } from "./guard-pool";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const runGuard = useGuardSync(guard);
const upstream = upstreamPath("hooks/guard_shell.py");
const pythonProbe = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
const python = pythonProbe.status === 0 && pythonProbe.stdout.trim() ? pythonProbe.stdout.trim() : "python3";
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
  // Shell edits of project files skip critique and acceptance (instructions audit 2026-10-03); temp files pass.
  bash("redirect production","echo x > src/production.ts",false),
  bash("redirect temp","echo x > /tmp/lane-pilot-test.log",true),
  bash("tee production","git log | tee src/production.ts",false),
  bash("sed in place production","sed -i s/a/b/ src/production.ts",false),
  bash("sed read","sed -n 1,5p src/production.ts",true),
  bash("tee temp","git log | tee /tmp/x.log",true),
  ...["Edit","Write","MultiEdit","NotebookEdit"].map((tool) => edit(`${tool} production`,tool,"src/app.ts",false)),
  ...["Edit","Write","MultiEdit","NotebookEdit"].flatMap((tool) => [
    edit(`${tool} progress`,tool,".agents/PROGRESS.md",false),
    edit(`${tool} plan`,tool,"docs/plans/x.md",true),
  ]),
  ...["Edit","Write","MultiEdit","NotebookEdit"].map((tool) => edit(`${tool} receipt`,tool,".agents/runs/r1/controller.json",false)),
  bash("adoc apply","adoc . --apply --writer-provider claude",true),
];

function invoke(path:string, testCase:Case) {
  const options = {
    input:JSON.stringify({
      agent_type:"lane-pilot-pm",
      tool_name:testCase.tool,
      tool_input:testCase.input,
      cwd,
    }),
    env:hookEnv({AGENT_HOOK_CLIENT:"claude"}),
  };
  return path === guard ? runGuard(options) : spawnSync("python3", [path], { ...options, encoding:"utf8" });
}

describe("E2 Lane Pilot PM guard", () => {
  it("keeps the normative table at 46 cases", () => expect(cases).toHaveLength(46));
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
    const options = { env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }) };
    const a = runGuard({ ...options, input: namespaced });
    const b = runGuard({ ...options, input: short });
    expect(a.status).toBe(b.status);
    expect(a.status).not.toBe(0);
  });

  it.skipIf(NO_UPSTREAM)("leaves representative upstream PM_AGENTS behavior byte-for-byte", () => {
    const probes = [
      bash("read","git status",true),
      bash("upstream mutation remains upstream","git add src/app.ts",true),
      bash("sed","sed -i x file",false),
      edit("doc","Edit","docs/plans/x.md",true),
      edit("source","Write","src/app.ts",false),
    ];
    for (const testCase of probes) {
      const payload = JSON.stringify({agent_type:"dev-orchestrator",tool_name:testCase.tool,tool_input:testCase.input,cwd});
      const options = {input:payload,encoding:"utf8" as const,env:hookEnv({AGENT_HOOK_CLIENT:"claude"})};
      const before = spawnSync(python,[upstream],options);
      const after = spawnSync(python,[guard],options);
      expect({status:after.status,stdout:after.stdout,stderr:after.stderr})
        .toEqual({status:before.status,stdout:before.stdout,stderr:before.stderr});
    }
  });
});

// 2026-10-09 refusals: the PM's temp files and its chat folder (any file type; thread.json and history/ stay closed), redirects that a
// leading `cd` moves, and heredoc bodies fed to something other than a shell, which are data and not shell syntax.
const chat = ".bb/chats/thr_d6zg57egme";
const pmFileCases: Case[] = [
  edit("Write temp .mts","Write","/tmp/tjs/s/eval.mts",true),
  edit("Write private temp .mts","Write","/private/tmp/tjs/s/eval.mts",true),
  edit("Write TMPDIR file","Write",join(tmpdir(),"tjs","eval.mts"),true),
  bash("sed -i temp script","sed -i 's/a/b/' /tmp/tjs/run.sh",true),
  bash("sed -i TMPDIR script","sed -i 's/a/b/' $TMPDIR/run.sh",true),
  bash("redirect TMPDIR","node run.mjs > $TMPDIR/out.json",true),
  edit("Write chat tmp .mts","Write",`${chat}/tmp/eval.mts`,true),
  edit("Write chat REPORT.md","Write",`${chat}/artifacts/skill-eval/REPORT.md`,true),
  bash("heredoc chat REPORT.md with > body",`cat > ${chat}/artifacts/skill-eval/REPORT.md <<'EOF'\n# Report\n> quoted line\n- a -> b\nEOF`,true),
  bash("cd chat then redirect labels.json",`cd ${chat}/artifacts/skill-eval && node run.mjs > labels.json`,true),
  bash("cd temp then redirect",`cd /tmp && node run.mjs > out.json`,true),
  bash("heredoc temp quoted body with <","cat > /tmp/x <<'EOF'\nif a < b then\nEOF",true),
  bash("heredoc temp, eval in the path, body with > and <","cat > /tmp/skill-eval/x.md <<'EOF'\n> a < b\nEOF",true),
  bash("heredoc body with a bb command word","cat > /tmp/x <<'EOF'\nok; bb thread new\nEOF",true),
  edit("Write chat thread.json","Write",`${chat}/thread.json`,false),
  edit("Write chat history","Write",`${chat}/history/a.md`,false),
  bash("redirect into chat thread.json",`echo x > ${chat}/thread.json`,false),
  bash("cd into chat history then redirect",`cd ${chat}/history && echo x > a.md`,false),
  bash("cd into project source then redirect","cd src && node x > out.txt",false),
  bash("redirect into project source","node x > src/out.ts",false),
  bash("sed -i project source","sed -i s/a/b/ src/app.ts",false),
  bash("heredoc into project source","cat > src/x.ts <<'EOF'\nhello\nEOF",false),
  bash("bash heredoc runs a project write","bash <<'EOF'\necho hi > src/x.ts\nEOF",false),
  bash("heredoc piped to sh runs a project write","cat <<'EOF' | sh\necho hi > src/x.ts\nEOF",false),
];

describe("E3 Lane Pilot PM temp files, chat folder, cd-relative redirects and heredoc bodies", () => {
  for (const testCase of pmFileCases) {
    it(`${testCase.name}: ${testCase.allowed ? "allow" : "deny"}`, () => {
      const result = invoke(guard,testCase);
      expect(result.status, result.stdout + result.stderr).toBe(testCase.allowed ? 0 : 2);
    });
  }

  it("keeps the project's own files closed when the checkout itself lies under a temp folder", () => {
    const checkout = mkdtempSync(join(tmpdir(), "lp-guard-checkout-"));
    try {
      const run = (command: string) => runGuard({
        input: JSON.stringify({ agent_type: "lane-pilot-pm", tool_name: "Bash", tool_input: { command }, cwd: checkout }),
        env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
      }).status;
      expect(run("sed -i s/a/b/ src/app.ts"), "sed -i src/app.ts").toBe(2);
      expect(run("echo x > src/app.ts"), "redirect into src/app.ts").toBe(2);
      expect(run("echo x > /tmp/lane-pilot-probe.log"), "redirect to /tmp").toBe(0);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
