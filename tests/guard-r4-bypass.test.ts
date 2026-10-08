import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BB_SHIM_NAMES, prepareBbShim } from "../src/rooms/native-agent/bb-shim";
import { OPENCODE_BASH_DENY } from "../src/rooms/native-install/opencode-min-config";
import { hookEnv } from "./hook-env";

// Audit 2026-10-08 round 4, P0-7: the ways past the shell guard (hub address in other notations, wrapper options that take a value). Since the
// owner decision of 2026-10-08 the guard stops only what breaks the hub by mistake (plugin admin commands, ssh to the hub): schedule, anamnesis and
// Env Catalog commands are open to every agent.
const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const temp = () => mkdtempSync(join(tmpdir(), "guard-r4-"));

type Verdict = { status: number | null; stdout: string };
const payloadOf = (command: string, agentType: string | null) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/tmp", ...(agentType ? { agent_type: agentType } : {}) });
const isDenied = (verdict: Verdict) => verdict.status === 2 && /\[hub-guard\]/.test(verdict.stdout);

const POOL = 8;
async function runMany(cases: Array<{ command: string; agentType: string | null; env?: Record<string, string> }>): Promise<Verdict[]> {
  const results: Verdict[] = new Array(cases.length);
  let next = 0;
  const one = (index: number) => new Promise<void>((done) => {
    const { command, agentType, env = {} } = cases[index]!;
    const child = spawn("python3", [guard], { env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }) });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (status) => { results[index] = { status, stdout }; done(); });
    child.stdin.end(payloadOf(command, agentType));
  });
  await Promise.all(Array.from({ length: Math.min(POOL, cases.length) }, async () => { for (let index = next++; index < cases.length; index = next++) await one(index); }));
  return results;
}

// A command a Lane Pilot writer or helper (strict) must not run, in a form that got past the first version of the guard.
const STRICT_DENIED: Array<[string, string]> = [
  // the bb binary by path or through a wrapper whose option takes a value
  ["absolute path to bb", "/opt/homebrew/bin/bb plugin remove A"],
  ["home path to bb", "~/.local/bin/bb plugin remove A"],
  ["quoted path to bb", "\"/usr/local/bin/bb\" plugin remove A"],
  ["BB_CLI binary path", "/Users/x/.bb-machines/m/npm/lib/node_modules/bb-app/host-daemon/dist/bb plugin remove A"],
  ["node path to bb", "node /opt/bb-app/dist/bb plugin remove A"],
  ["command -p", "command -p bb plugin remove A"],
  ["command -p absolute", "command -p /usr/local/bin/bb plugin remove A"],
  ["env bb", "env bb plugin remove A"],
  ["/usr/bin/env bb", "/usr/bin/env bb plugin remove A"],
  ["env -u NAME", "env -u HTTP_PROXY bb plugin remove A"],
  ["env -C dir", "env -C /tmp bb plugin remove A"],
  ["env -S string", "env -S 'bb plugin remove A'"],
  ["env --split-string", "env --split-string='bb plugin remove A'"],
  ["sudo -u user", "sudo -u root bb plugin remove A"],
  ["timeout -s SIGNAL", "timeout -s KILL 5 bb plugin remove A"],
  ["exec -a name", "exec -a x bb plugin remove A"],
  ["nice -n N", "nice -n 5 bb plugin remove A"],
  ["xargs -I", "echo A | xargs -I{} bb plugin remove {}"],
  ["nested wrappers", "sudo -u root env -u X timeout -s KILL 5 /usr/bin/bb plugin remove A"],
  // the hub in other notations
  ["ssh 10.8.1", "ssh ubuntu@10.8.1"],
  ["ssh 10.524289", "ssh ubuntu@10.524289"],
  ["ssh hex", "ssh ubuntu@0x0a080001"],
  ["ssh short hex", "ssh 0xa080001"],
  ["ssh decimal", "ssh 168296449"],
  ["ssh octal", "ssh 012.010.0.1"],
  ["ssh mixed notation", "ssh 10.0x8.0.1"],
  ["ssh trailing dot", "ssh ubuntu@10.8.0.1."],
  ["ssh public address as a number", "ssh 908427673"],
  ["ssh public address in hex", "ssh 0x36258199"],
  ["ssh IPv6-mapped", "ssh ::ffff:10.8.0.1"],
  ["ssh IPv6-mapped in brackets", "ssh -6 ubuntu@[::ffff:10.8.0.1]"],
  ["ssh IPv6-mapped hex", "ssh ubuntu@::ffff:a08:1"],
  ["ssh IPv6 long form", "ssh 0:0:0:0:0:ffff:a08:1"],
  ["ssh IPv6 upper case", "ssh ::FFFF:A08:1"],
  ["scp from a number", "scp ubuntu@10.8.1:/etc/passwd /tmp/x"],
  ["scp from an IPv6-mapped address", "scp ubuntu@[::ffff:10.8.0.1]:/etc/passwd /tmp/x"],
  ["rsync from hex", "rsync -a ubuntu@0x0a080001:/home /tmp/x"],
  ["sftp ssh:// URL", "sftp sftp://ubuntu@10.8.1/home"],
  ["-o HostName", "ssh -o HostName=10.8.1 anything"],
  ["ProxyJump", "ssh -J ubuntu@10.8.1 vast"],
  ["absolute ssh", "/usr/bin/ssh ubuntu@10.8.1 id"],
  ["command -p ssh", "command -p ssh ubuntu@0x0a080001 id"],
  ["hop inside a quoted remote command", "ssh vast 'ssh ubuntu@10.8.1 id'"],
  ["rescue-vps", "ssh rescue-vps"],
  ["sudo -u ssh", "sudo -u root ssh ubuntu@10.8.1"],
];

// The PM reads and changes the anamnesis, the schedule board and Env Catalog through the bb CLI, and reaches the hub.
const PM_ALLOWED = [
  "bb lane-pilot anamnesis status",
  "bb lane-pilot anamnesis list --kind fact --json",
  "bb lane-pilot anamnesis confirm rec_1",
  "bb lane-pilot anamnesis forget rec_1",
  "bb lane-pilot anamnesis sources --set git=on",
  "bb lane-pilot anamnesis load --run --classify --yes",
  "bb lane-pilot schedule create '{}'",
  "bb lane-pilot schedule run-now sch_1",
  "bb plugin rpc call lane-pilot schedule_upsert --input-file x.json",
  "bb plugin rpc call lane-pilot save_setting --input-file x.json",
  "bb env-catalog get MY_KEY",
  "bb env-catalog set MY_KEY value",
  "bb env-catalog delete MY_KEY",
  "ssh ovh-main uptime",
  "ssh ubuntu@10.8.1 uptime",
];

const STRICT_ALLOWED = [
  "ssh vast nvidia-smi",
  "ssh -i ~/.ssh/key -p 2222 user@192.168.1.5 ls",
  "ssh 10.8.2.1",
  "ssh 10.9.0.1",
  "ssh 8.8.8.8",
  "ssh 012.8.0.2",
  "ssh 168296450",
  "ssh ::1",
  "ssh ::ffff:10.8.0.2",
  "scp a.txt vast:/tmp/a.txt",
  "rsync -a ./dist/ user@192.168.1.5:/var/www/",
  "bb lane-pilot schedule list --json",
  "bb lane-pilot schedule show sch_1",
  "bb lane-pilot schedule history sch_1",
  "bb plugin rpc call lane-pilot schedule_list --input '{}'",
  "bb plugin rpc call lane-pilot schedule_runs --input '{\"id\":\"sch_1\"}'",
  "bb env-catalog request MY_KEY --purpose 'set up the deploy'",
  "bb env-catalog set MY_KEY value", "bb env-catalog delete MY_KEY", "bb env-catalog get MY_KEY --raw",
  "bb lane-pilot schedule create '{}'", "bb lane-pilot anamnesis forget --all --yes", "bb plugin rpc call lane-pilot save_setting --input-file x.json",
  "sudo -u root ls /tmp",
  "env -u FOO printenv BAR",
  "timeout -s KILL 5 sleep 1",
  "echo 'ssh ubuntu@10.8.1' > /tmp/note.txt",
  "grep -rn 'lane-pilot anamnesis' docs",
];

const STRICT_ROLES: Array<[string, string | null, Record<string, string>]> = [
  ["errand helper", "errand", {}],
  ["writer", "writer", {}],
  ["specialist", "specialist:design-lead", {}],
  ["a session with no agent_type", null, { LANE_PILOT_AGENT_TYPE: "writer" }],
];
const PM_ROLES: Array<[string, string | null, Record<string, string>]> = [
  ["Lane Pilot PM", "lane-pilot-pm", {}],
  ["native PM", "dev-orchestrator", { LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" }],
];

describe("the shell guard against the round 4 bypasses", () => {
  for (const [role, agentType, env] of STRICT_ROLES) {
    it(`denies every bypass form for ${role}`, async () => {
      const verdicts = await runMany(STRICT_DENIED.map(([, command]) => ({ command, agentType, env })));
      expect(STRICT_DENIED.filter((_, index) => !isDenied(verdicts[index]!)).map(([name]) => name)).toEqual([]);
    }, 60_000);
  }

  for (const [role, agentType, env] of PM_ROLES) {
    it(`lets the reads, the writes of the owner's records, the schedule calls and the hub through for ${role}`, async () => {
      const verdicts = await runMany(PM_ALLOWED.map((command) => ({ command, agentType, env })));
      expect(PM_ALLOWED.filter((_, index) => verdicts[index]!.status === 2)).toEqual([]);
    }, 60_000);
  }

  it("leaves ordinary commands alone for a writer and an errand helper", async () => {
    const cases = STRICT_ALLOWED.flatMap((command) => STRICT_ROLES.slice(0, 2).map(([role, agentType, env]) => ({ role, command, agentType, env })));
    const verdicts = await runMany(cases);
    cases.forEach(({ role, command }, index) => {
      expect(`${role}: ${command}: ${isDenied(verdicts[index]!)}`).toBe(`${role}: ${command}: false`);
    });
  });

  it("does not touch a session that is not a Lane Pilot agent", async () => {
    const verdicts = await runMany(["ssh ubuntu@10.8.1", "bb plugin remove lane-pilot", "env -u X bb plugin remove A"].map((command) => ({ command, agentType: "Explore" })));
    expect(verdicts.map(isDenied)).toEqual([false, false, false]);
  });

  it("reads the file BB_CLI points at as bb, whatever it is called", async () => {
    const odd = "/opt/tools/bbctl";
    const [named, other] = await runMany([
      { command: `${odd} plugin remove A`, agentType: "errand", env: { BB_CLI: odd } },
      { command: `${odd} plugin remove A`, agentType: "errand" },
    ]);
    expect(isDenied(named!)).toBe(true);
    expect(isDenied(other!)).toBe(false);
  });

  describe("names that only a config file or DNS ties to the hub", () => {
    const home = temp();
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "config"), [
      "Host sneaky",
      "  HostName 10.8.1",
      "Host mapped hub-alias",
      "  HostName ::ffff:10.8.0.1",
      "Host vast",
      "  HostName 203.0.113.9",
      "Host chained",
      "  HostName hub.example.com",
      "",
    ].join("\n"));

    // A driver that runs the guard with the resolver replaced: hub.example.com and v6.example.com answer with the hub, other.example.com does not,
    // anything else does not resolve. The names it was asked for go to stderr.
    const driver = join(temp(), "drive-guard.py");
    writeFileSync(driver, [
      "import atexit, io, json, runpy, socket, sys",
      "asked = []",
      "def fake(host, *args, **kwargs):",
      "    asked.append(host)",
      "    if host == 'hub.example.com': return [(2, 1, 6, '', ('10.8.0.1', 0))]",
      "    if host == 'v6.example.com': return [(10, 1, 6, '', ('::ffff:a08:1', 0, 0, 0))]",
      "    if host == 'other.example.com': return [(2, 1, 6, '', ('203.0.113.5', 0))]",
      "    raise socket.gaierror('no such name')",
      "socket.getaddrinfo = fake",
      "atexit.register(lambda: sys.stderr.write('ASKED ' + json.dumps(asked)))",
      "sys.stdin = io.StringIO(sys.argv[2])",
      "sys.argv = [sys.argv[1]]",
      "runpy.run_path(sys.argv[0], run_name='__main__')",
      "",
    ].join("\n"));
    const drive = (command: string) => {
      const res = spawnSync("python3", [driver, guard, payloadOf(command, "errand")], { encoding: "utf8", env: hookEnv({ AGENT_HOOK_CLIENT: "claude", HOME: home }) });
      return { denied: isDenied({ status: res.status, stdout: res.stdout }), asked: JSON.parse(/ASKED (.*)$/s.exec(res.stderr)?.[1] ?? "[]") as string[] };
    };

    it("refuses an alias of ~/.ssh/config whose HostName is the hub in another notation", () => {
      for (const command of ["ssh sneaky", "scp sneaky:/etc/passwd /tmp/x", "ssh ubuntu@mapped", "ssh hub-alias", "rsync -a SNEAKY:/home /tmp/x"]) {
        expect(drive(command).denied, command).toBe(true);
      }
    });

    it("refuses a name that resolves to the hub", () => {
      for (const command of ["ssh hub.example.com", "ssh ubuntu@hub.example.com id", "scp hub.example.com:/etc/passwd /tmp/x", "ssh v6.example.com", "ssh chained", "ssh ubuntu@HUB.example.com."]) {
        expect(drive(command).denied, command).toBe(true);
      }
    });

    it("lets a name through that resolves elsewhere or not at all, and does not look up words that are not host names", () => {
      expect(drive("ssh other.example.com").denied).toBe(false);
      expect(drive("ssh nowhere.example.com").denied).toBe(false);
      expect(drive("ssh vast nvidia-smi").denied).toBe(false);
      const quiet = drive("ssh -i ~/.ssh/id_rsa.pub -o StrictHostKeyChecking=no vast ls /var/log/syslog");
      expect(quiet.denied).toBe(false);
      expect(quiet.asked).toEqual([]);
    });
  });
});

// The PATH wrappers (Codex and Cursor writers, OpenCode) and the OpenCode permission rules.
const SHELLS = ["sh", ...(spawnSync("dash", ["-c", "exit 0"]).status === 0 ? ["dash"] : [])];

async function shimSetup() {
  const dataDir = temp();
  const real = temp();
  for (const name of BB_SHIM_NAMES) {
    writeFileSync(join(real, name), `#!/bin/sh\necho "REAL ${name} $*"\n`);
    chmodSync(join(real, name), 0o755);
  }
  const shim = await prepareBbShim({ dataDir, path: `${real}:/usr/bin:/bin` });
  return (shell: string, program: string, ...args: string[]) => spawnSync(shell, [join(shim.dir, program), ...args], { encoding: "utf8", env: { PATH: shim.path, HOME: dataDir } });
}

const SHIM_DENIED: Array<[string, string[]]> = [
  ["ssh", ["ubuntu@10.8.1"]],
  ["ssh", ["ubuntu@10.524289", "id"]],
  ["ssh", ["0x0a080001"]],
  ["ssh", ["-l", "ubuntu", "0X0A080001"]],
  ["ssh", ["0xa080001"]],
  ["ssh", ["168296449"]],
  ["ssh", ["012.010.0.1"]],
  ["ssh", ["10.0x8.0.1"]],
  ["ssh", ["ubuntu@10.8.0.1."]],
  ["ssh", ["908427673"]],
  ["ssh", ["0x36258199"]],
  ["ssh", ["::ffff:10.8.0.1"]],
  ["ssh", ["-6", "ubuntu@[::ffff:10.8.0.1]"]],
  ["ssh", ["ubuntu@::ffff:a08:1"]],
  ["ssh", ["0:0:0:0:0:ffff:a08:1"]],
  ["ssh", ["::FFFF:A08:1"]],
  ["ssh", ["-o", "HostName=10.8.1", "anything"]],
  ["ssh", ["-J", "ubuntu@10.8.1,other", "vast"]],
  ["ssh", ["sftp://ubuntu@10.8.1/x"]],
  ["ssh", ["vast", "ssh ubuntu@10.8.1 id"]],
  ["ssh", ["rescue-vps"]],
  ["scp", ["ubuntu@10.8.1:/etc/passwd", "/tmp/x"]],
  ["scp", ["ubuntu@[::ffff:10.8.0.1]:/etc/passwd", "/tmp/x"]],
  ["sftp", ["ubuntu@0x0a080001"]],
  ["bb", ["plugin", "remove", "lane-pilot"]],
  ["bb", ["--json", "plugin", "safe-mode", "on"]],
];
const SHIM_ALLOWED: Array<[string, string[]]> = [
  ["ssh", ["vast", "nvidia-smi"]],
  ["ssh", ["-p", "2222", "user@192.168.1.5", "ls"]],
  ["ssh", ["10.8.2.1"]],
  ["ssh", ["10.9.0.1"]],
  ["ssh", ["8.8.8.8"]],
  ["ssh", ["012.8.0.2"]],
  ["ssh", ["168296450"]],
  ["ssh", ["089.1.1.1"]],
  ["ssh", ["::1"]],
  ["ssh", ["::ffff:10.8.0.2"]],
  ["ssh", ["-o", "StrictHostKeyChecking=no", "vast", "ls"]],
  ["scp", ["a.txt", "vast:/tmp/a.txt"]],
  ["bb", ["lane-pilot", "schedule", "list", "--json"]],
  ["bb", ["lane-pilot", "schedule", "show", "sch_1"]],
  ["bb", ["lane-pilot", "schedule", "history", "sch_1"]],
  ["bb", ["plugin", "rpc", "call", "lane-pilot", "schedule_list", "--input", "{}"]],
  ["bb", ["plugin", "rpc", "call", "lane-pilot", "schedule_runs", "--input", "{}"]],
  ["bb", ["plugin", "rpc", "call", "lane-pilot", "get_run", "--input", "{}"]],
  ["bb", ["env-catalog", "request", "NEW_KEY"]],
  ["bb", ["env-catalog", "set", "A", "value"]],
  ["bb", ["lane-pilot", "schedule", "create", "{}"]],
  ["bb", ["lane-pilot", "anamnesis", "forget", "--all", "--yes"]],
  ["bb", ["plugin", "rpc", "call", "lane-pilot", "schedule_upsert", "--input", "{}"]],
];

describe("the PATH wrappers against the round 4 bypasses", () => {
  for (const shell of SHELLS) {
    for (const [program, args] of SHIM_DENIED) {
      it(`${shell}: refuses ${program} ${args.join(" ")}`, async () => {
        const res = (await shimSetup())(shell, program, ...args);
        expect(res.status).toBe(126);
        expect(res.stderr).toContain("[hub-guard]");
        expect(res.stdout).not.toContain("REAL");
      });
    }
    it(`${shell}: runs the real program for what is not the hub or a write`, async () => {
      const run = await shimSetup();
      const wrong = SHIM_ALLOWED.flatMap(([program, args]) => {
        const res = run(shell, program, ...args);
        return res.status === 0 && res.stdout.trim() === `REAL ${program} ${args.join(" ")}` ? [] : [`${program} ${args.join(" ")} -> ${res.status} ${res.stderr}`];
      });
      expect(wrong).toEqual([]);
    });
  }
});

// OpenCode matches a glob against the whole command line.
const globMatches = (pattern: string, command: string) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(command);
const openCodeDenies = (command: string) => OPENCODE_BASH_DENY.some((pattern) => globMatches(pattern, command));

describe("the OpenCode bash deny list against the round 4 bypasses", () => {
  const DENIED = [
    "$BB_CLI plugin config lane-pilot",
    "/opt/homebrew/bin/bb plugin remove lane-pilot",
    "ssh ubuntu@10.8.1",
    "ssh ubuntu@0x0a080001 id",
    "ssh 168296449",
    "ssh 012.010.0.1",
    "ssh ::ffff:10.8.0.1",
    "ssh ubuntu@::ffff:a08:1",
    "scp ubuntu@0x0A080001:/x /tmp",
    "rsync -a ubuntu@168296449:/home /tmp",
    "sftp ubuntu@908427673",
    "ssh rescue-vps",
  ];
  for (const command of DENIED) it(`denies ${command}`, () => expect(openCodeDenies(command)).toBe(true));

  for (const command of [
    "bb lane-pilot schedule list --json",
    "bb lane-pilot schedule create '{}'",
    "bb lane-pilot anamnesis forget --all --yes",
    "bb plugin rpc call lane-pilot schedule_upsert --input '{}'",
    "bb plugin rpc call lane-pilot save_setting --input '{}'",
    "bb env-catalog set A B",
    "bb env-catalog get MY_KEY --raw",
    "bb env-catalog list",
    "ssh vast nvidia-smi",
    "ssh 10.9.0.1",
    "git status",
  ]) it(`lets through ${command}`, () => expect(openCodeDenies(command)).toBe(false));
});

describe("the three lists carry the same plugin admin entries", () => {
  it("guard, wrapper and OpenCode all refuse every plugin admin command", async () => {
    const run = await shimSetup();
    const commands = ["config", "token", "disable", "enable", "reload", "remove", "safe-mode"].map((sub) => ({ line: `bb plugin ${sub} x`, program: "bb", args: ["plugin", sub, "x"] }));
    const verdicts = await runMany(commands.map(({ line }) => ({ command: line, agentType: "writer" })));
    commands.forEach(({ line, program, args }, index) => {
      expect(isDenied(verdicts[index]!), `guard: ${line}`).toBe(true);
      expect(run("sh", program, ...args).status, `wrapper: ${line}`).toBe(126);
      expect(openCodeDenies(line), `OpenCode: ${line}`).toBe(true);
    });
  });
});
