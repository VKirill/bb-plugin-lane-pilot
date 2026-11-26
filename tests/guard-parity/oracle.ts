import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_ADDRESS_INTS, HUB_NAMES } from "../../src/rooms/contracts/hub-deny";
import {
  buildBubblewrapArgs,
  buildSeatbeltProfile,
  credentialMaskPaths,
  resolveSandboxBackend,
} from "../../src/rooms/verification/sandbox";

export type OracleShell = "bash" | "zsh";

export type OracleRun = {
  id: string;
  shell: OracleShell;
  argvs: string[][];
  timedOut: boolean;
  exitCode: number | null;
};

export type OracleResult = {
  id: string;
  runs: OracleRun[];
  protectedRan: boolean;
  protectedArgvs: Array<{ shell: OracleShell; argv: string[] }>;
};

export const PROTECTED_PROGRAMS = [
  "git", "gh", "rm", "unlink", "shred",
  "ssh", "scp", "sftp", "rsync", "mosh", "autossh",
  "bb", "bb-app", "bb-cli", "bb.js",
  "curl", "npm", "pnpm", "yarn", "bun",
  "psql", "mysql", "mariadb", "sqlite3", "sqlcmd",
  "run-controller", "run-init", "wt-merge-main", "lane-ctl", "lane-bg", "lane-exec",
] as const;

const PROTECTED_SET = new Set<string>([...PROTECTED_PROGRAMS, "find"]);

const WRITER_GIT_ALLOWED = new Set([
  "status", "diff", "log", "show", "add", "commit", "restore", "checkout", "switch",
  "branch", "stash", "rev-parse", "ls-files", "fetch", "grep", "archive",
  "check-ignore", "describe", "shortlog", "merge-base", "cat-file", "blame",
]);

const HELPER_GIT_MUTATING = new Set([
  "add", "commit", "push", "merge", "checkout", "restore", "reset", "rebase", "tag", "branch",
]);

const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source", "--list-cmds",
]);

const BB_ADMIN_SUBS = new Set(["config", "token", "disable", "enable", "reload", "remove", "safe-mode"]);
const REMOTE_SHELLS = new Set(["ssh", "scp", "sftp", "rsync", "mosh", "autossh"]);
const HUB_NAME_SET = new Set<string>(HUB_NAMES);
const HUB_INT_SET = new Set<number>(HUB_ADDRESS_INTS);

const DISPOSABLE_SEGMENTS = new Set([
  "node_modules", "dist", "build", ".next", ".nuxt", ".output", ".cache", "coverage", ".turbo", ".vite",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "tmp", ".tmp",
]);
const DISPOSABLE_ROOTS = ["/tmp/", "/private/tmp/", "/var/tmp/", "/var/folders/", "/dev/null"];
const SQL_MUTATION_RE = /\b(?:insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|comment|vacuum|reindex|cluster|refresh)\b/i;
const SQL_DESTROY_RE = /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i;
const SQL_DELETE_RE = /\bdelete\s+from\s+\w+\b/i;

export function oracleShells(): OracleShell[] {
  const shells: OracleShell[] = ["bash"];
  if (existsSync("/bin/zsh")) shells.push("zsh");
  return shells;
}

function ipv4Int(text: string): number | null {
  const parts = text.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (/^0[xX][0-9a-fA-F]*$/.test(part)) nums.push(parseInt(part.slice(2) || "0", 16));
    else if (/^0[0-7]*$/.test(part)) nums.push(parseInt(part || "0", 8));
    else if (/^[1-9][0-9]*$/.test(part)) nums.push(Number(part));
    else return null;
  }
  const head = nums.slice(0, -1);
  const last = nums.at(-1)!;
  if (head.some((n) => n > 255) || last >= 256 ** (4 - head.length)) return null;
  let value = last;
  head.forEach((n, idx) => { value = (value | (n << (24 - 8 * idx))) >>> 0; });
  return value >>> 0;
}

function addressInt(text: string): number | null {
  if (!text.includes(":")) return ipv4Int(text);
  const noZone = text.split("%", 1)[0] ?? "";
  const v4Match = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/i.exec(noZone);
  if (v4Match) return ipv4Int(v4Match[1]!);
  const hexMatch = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/i.exec(noZone);
  if (hexMatch) {
    return (((parseInt(hexMatch[1]!, 16) << 16) | parseInt(hexMatch[2]!, 16)) >>> 0);
  }
  return null;
}

function reachesHub(args: string[]): boolean {
  const words: string[] = [];
  for (const arg of args) {
    words.push(arg);
    for (const piece of arg.split(/[\s'"]+/)) if (piece && piece !== arg) words.push(piece);
  }
  for (const word of words) {
    const bracketed = [...word.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!);
    const chunks = word.split(/[=,]/).map((chunk) => {
      const stripped = chunk.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "").split("/", 1)[0]!.split("@").at(-1)!.replace(/^\[|\]$/g, "");
      return (stripped.match(/:/g)?.length ?? 0) >= 2 ? stripped : stripped.split(":", 1)[0]!;
    });
    for (const raw of [...bracketed, ...chunks]) {
      const cand = raw.toLowerCase().replace(/\.$/, "");
      if (!cand) continue;
      if (HUB_NAME_SET.has(cand)) return true;
      const num = addressInt(cand);
      if (num !== null && HUB_INT_SET.has(num)) return true;
    }
  }
  return false;
}

function isDisposable(path: string): boolean {
  if (DISPOSABLE_ROOTS.some((root) => path.startsWith(root))) return true;
  return path.replace(/\\/g, "/").split("/").some((part) => DISPOSABLE_SEGMENTS.has(part));
}

function gitSubcommandInfo(args: string[]): { sub: string | null; rest: string[]; hasAliasConfig: boolean } {
  let i = 0;
  let hasAliasConfig = false;
  while (i < args.length) {
    const tok = args[i]!;
    if (tok === "--") return { sub: args[i + 1] ?? null, rest: args.slice(i + 2), hasAliasConfig };
    if (!tok.startsWith("-")) return { sub: tok, rest: args.slice(i + 1), hasAliasConfig };
    if (tok === "-c" && i + 1 < args.length) {
      if (args[i + 1]!.toLowerCase().startsWith("alias.")) hasAliasConfig = true;
      i += 2;
      continue;
    }
    if (tok.startsWith("-c") && tok.length > 2 && !tok.startsWith("--")) {
      if (tok.slice(2).toLowerCase().startsWith("alias.")) hasAliasConfig = true;
      i += 1;
      continue;
    }
    if (tok === "--config-env" && i + 1 < args.length) {
      if (args[i + 1]!.toLowerCase().startsWith("alias.")) hasAliasConfig = true;
      i += 2;
      continue;
    }
    if (tok.startsWith("--config-env=") && tok.slice("--config-env=".length).toLowerCase().startsWith("alias.")) {
      hasAliasConfig = true;
    }
    if (tok.includes("=") || (tok.startsWith("-C") && tok !== "-C")) {
      i += 1;
      continue;
    }
    i += GIT_GLOBAL_VALUE_OPTS.has(tok) ? 2 : 1;
  }
  return { sub: null, rest: [], hasAliasConfig };
}

function isSqlProtected(args: string[]): boolean {
  if (args.some((t) => t === "-f" || t === "--file")) return true;
  const queries: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if ((tok === "-c" || tok === "--command") && i + 1 < args.length) queries.push(args[i + 1]!);
    else if (!tok.startsWith("-")) queries.push(tok);
  }
  for (const q of queries) {
    if (SQL_DESTROY_RE.test(q)) return true;
    if (SQL_DELETE_RE.test(q) && !/\bwhere\b/i.test(q)) return true;
    if (SQL_MUTATION_RE.test(q) && /\b(?:drop|truncate)\b/i.test(q)) return true;
  }
  return false;
}

export function isProtectedArgv(argv: string[], role: string): boolean {
  if (!argv.length) return false;
  const exe = argv[0]!.split("/").at(-1)!;
  const args = argv.slice(1);
  const isWriter = role === "writer" || role === "emergency-writer";
  const isHelper = role !== "lane-pilot-pm" && role !== "dev-orchestrator" && !isWriter;
  const isStrict = role !== "lane-pilot-pm";

  if (isStrict) {
    if (/^(?:@[\w.-]+\/)?bb(?:-app|-cli)?(?:\.[cm]?js)?(?:@[\w.-]+)?$/.test(exe)) {
      const words = args.filter((a) => !a.startsWith("-"));
      for (let i = 0; i < Math.min(words.length, 3); i++) {
        if (words[i] === "plugin" && words[i + 1] && BB_ADMIN_SUBS.has(words[i + 1]!)) return true;
      }
    }
    if (REMOTE_SHELLS.has(exe) && reachesHub(args)) return true;
  }

  if (exe === "git") {
    const { sub, rest, hasAliasConfig } = gitSubcommandInfo(args);
    if (isWriter) {
      if (hasAliasConfig) return true;
      if (!sub) return false;
      if (!WRITER_GIT_ALLOWED.has(sub)) return true;
      if (sub === "config" && rest.some((a) => a.toLowerCase().startsWith("alias."))) return true;
      if (sub === "reset" && rest.some((a) => a === "--hard" || a.startsWith("--hard="))) return true;
      if (sub === "clean" && rest.some((a) => a === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))) return true;
      if ((sub === "checkout" || sub === "restore") && rest.includes(".")) return true;
    } else if (isHelper) {
      if (sub && HELPER_GIT_MUTATING.has(sub)) return true;
    } else {
      if (sub === "push" && rest.some((a) => a === "--force" || a.startsWith("--force=") || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || (a.startsWith("+") && a.length > 1)) && !rest.some((a) => a.startsWith("--force-with-lease"))) {
        return true;
      }
    }
    if (sub && ["commit", "push", "merge"].includes(sub) && rest.includes("--no-verify")) return true;
    return false;
  }

  if (exe === "gh" && isWriter) {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "release") return true;
  }

  if (["npm", "pnpm", "yarn", "bun"].includes(exe) && isWriter) {
    const words = args.filter((a) => !a.startsWith("-"));
    if (words[0] === "publish" || (words[0] === "pkg" && words[1] === "publish")) return true;
  }

  if (["rm", "unlink", "shred"].includes(exe)) {
    let afterDash = false;
    const targets: string[] = [];
    for (const a of args) {
      if (afterDash || !a.startsWith("-") || a === "-") targets.push(a);
      else if (a === "--") afterDash = true;
    }
    if (targets.some((t) => !isDisposable(t))) return true;
    return false;
  }

  if (exe === "find" && args.includes("-delete")) {
    const roots: string[] = [];
    for (const a of args) {
      if (a.startsWith("-") || a === "(" || a === "!") break;
      roots.push(a);
    }
    if ((roots.length ? roots : ["."]).some((r) => !isDisposable(r))) return true;
    return false;
  }

  if (["psql", "mysql", "mariadb", "sqlite3", "sqlcmd"].includes(exe)) {
    return isSqlProtected(args);
  }

  if (["run-controller", "run-init", "wt-merge-main", "lane-bg", "lane-exec"].includes(exe) && role === "lane-pilot-pm") {
    return true;
  }
  if (exe === "lane-ctl" && role === "lane-pilot-pm") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub && ["start", "retry", "fallback"].includes(sub)) return true;
  }

  return false;
}

function createStubs(stubsDir: string, defaultLogPath: string): void {
  mkdirSync(stubsDir, { recursive: true });
  const quotedDefault = `'${defaultLogPath.replace(/'/g, "'\\''")}'`;
  for (const name of PROTECTED_PROGRAMS) {
    const body = [
      "#!/bin/sh",
      `LOG_FILE="\${LP_ORACLE_LOG:-${quotedDefault}}"`,
      `printf '__LP_REC__\\t' >> "$LOG_FILE"`,
      `printf '%s\\0' ${JSON.stringify(name)} "$@" >> "$LOG_FILE"`,
      `printf '__LP_END__\\n' >> "$LOG_FILE"`,
      "exit 0",
      "",
    ].join("\n");
    const target = join(stubsDir, name);
    writeFileSync(target, body, { encoding: "utf8" });
    chmodSync(target, 0o755);
  }
  // find delegates -exec to real /usr/bin/find so `find ... -exec bb ...` invokes <stubs>/bb, while logging -delete.
  const findBody = [
    "#!/bin/sh",
    `LOG_FILE="\${LP_ORACLE_LOG:-${quotedDefault}}"`,
    'for a in "$@"; do',
    '  if [ "$a" = "-delete" ]; then',
    `    printf '__LP_REC__\\t' >> "$LOG_FILE"`,
    `    printf '%s\\0' "find" "$@" >> "$LOG_FILE"`,
    `    printf '__LP_END__\\n' >> "$LOG_FILE"`,
    "    exit 0",
    "  fi",
    "done",
    'exec /usr/bin/find "$@"',
    "",
  ].join("\n");
  writeFileSync(join(stubsDir, "find"), findBody, { encoding: "utf8" });
  chmodSync(join(stubsDir, "find"), 0o755);
}

function parseStubLog(raw: string): string[][] {
  const out: string[][] = [];
  for (const chunk of raw.split("__LP_REC__\t")) {
    const end = chunk.indexOf("__LP_END__\n");
    if (end < 0) continue;
    const payload = chunk.slice(0, end);
    const fields = payload.split("\0");
    if (fields.at(-1) === "") fields.pop();
    if (fields.length > 0) out.push(fields);
  }
  return out;
}

function parseZshXtrace(raw: string): string[][] {
  const out: string[][] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("+LPX+ ")) continue;
    const body = line.slice(6).trim();
    if (!body) continue;
    const words = body.split(/\s+/);
    const head = words[0]?.replace(/^['"]|['"]$/g, "") ?? "";
    const base = head.split("/").at(-1) ?? "";
    // Only capture direct/glob absolute calls that bypassed PATH stubs (e.g. /usr/bin/git, /bin/rm).
    if (head.startsWith("/") && PROTECTED_SET.has(base)) {
      out.push([base, ...words.slice(1).map((w) => w.replace(/^['"]|['"]$/g, ""))]);
    }
  }
  return out;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Runs every corpus command through real bash (and zsh when installed) with stub binaries that log argv,
 * inside the sandbox policy of src/rooms/verification/sandbox.ts.
 */
export async function runOracleBatch(
  cases: Array<{ id: string; command: string; role?: string }>,
): Promise<Map<string, OracleResult>> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lp-guard-oracle-")));
  const workspacePath = join(root, "work");
  const tempPath = join(root, "tmp");
  const stubsDir = join(root, "stubs");
  const logPath = join(tempPath, "argv.log");
  const xtracePath = join(tempPath, "xtrace.log");
  const runnerPath = join(tempPath, "runner.mjs");
  const inputPath = join(tempPath, "cases.json");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(tempPath, { recursive: true });
  createStubs(stubsDir, logPath);
  writeFileSync(inputPath, JSON.stringify(cases), "utf8");

  const shells = oracleShells();
  const runnerCode = `
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const cases = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, "utf8"));
const shells = ${JSON.stringify(shells)};
const stubsDir = ${JSON.stringify(stubsDir)};
const logPath = ${JSON.stringify(logPath)};
const xtracePath = ${JSON.stringify(xtracePath)};
const workRoot = ${JSON.stringify(workspacePath)};
const tmpRoot = ${JSON.stringify(tempPath)};
const basePath = [stubsDir, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin"].join(":");

function parseStubLog(raw) {
  const out = [];
  for (const chunk of raw.split("__LP_REC__\\t")) {
    const end = chunk.indexOf("__LP_END__\\n");
    if (end < 0) continue;
    const fields = chunk.slice(0, end).split("\\0");
    if (fields.at(-1) === "") fields.pop();
    if (fields.length > 0) out.push(fields);
  }
  return out;
}

function parseZshXtrace(raw) {
  const out = [];
  const protectedNames = new Set(${JSON.stringify([...PROTECTED_SET])});
  for (const line of raw.split("\\n")) {
    if (!line.startsWith("+LPX+ ")) continue;
    const body = line.slice(6).trim();
    if (!body) continue;
    const words = body.split(/\\s+/);
    const head = (words[0] || "").replace(/^['"]|['"]$/g, "");
    const base = head.split("/").at(-1) || "";
    if (head.startsWith("/") && !head.startsWith(stubsDir + "/") && protectedNames.has(base)) {
      out.push([base, ...words.slice(1).map((w) => w.replace(/^['"]|['"]$/g, ""))]);
    }
  }
  return out;
}

const results = [];
for (let idx = 0; idx < cases.length; idx++) {
  const item = cases[idx];
  const runs = [];
  for (const shell of shells) {
    const caseWork = join(workRoot, "c-" + idx + "-" + shell);
    const caseTmp = join(tmpRoot, "c-" + idx + "-" + shell);
    const caseLog = join(caseTmp, "argv.log");
    mkdirSync(join(caseWork, "src"), { recursive: true });
    mkdirSync(caseTmp, { recursive: true });
    writeFileSync(join(caseWork, "src", "app.ts"), "export const x = 1;\\n");
    writeFileSync(join(caseWork, "x"), "fixture\\n");
    writeFileSync(logPath, "");
    writeFileSync(caseLog, "");
    writeFileSync(xtracePath, "");
    const bin = shell === "zsh" ? "/bin/zsh" : "/bin/bash";
    const args = shell === "zsh"
      ? ["-x", "--no-rcs", "-c", item.command]
      : ["--noprofile", "--norc", "-c", item.command];
    const env = {
      PATH: basePath,
      HOME: caseTmp,
      TMPDIR: caseTmp,
      TMP: caseTmp,
      TEMP: caseTmp,
      LP_ORACLE_LOG: caseLog,
      LANG: "C",
      LC_ALL: "C",
      ...(shell === "zsh" ? { ZSH_XTRACEFD: "7", PS4: "+LPX+ " } : {}),
    };
    const res = shell === "zsh"
      ? spawnSync("/bin/zsh", ["--no-rcs", "-c", 'ZSH_XTRACEFD=7 PS4="+LPX+ " "$@" 7>' + JSON.stringify(xtracePath), "zsh", bin, ...args], {
          cwd: caseWork,
          env,
          encoding: "utf8",
          timeout: 2000,
          stdio: "ignore",
        })
      : spawnSync(bin, args, {
          cwd: caseWork,
          env,
          encoding: "utf8",
          timeout: 2000,
          stdio: "ignore",
        });
    if (item.command.includes(">(")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    const stubArgvs = [...parseStubLog(readFileSync(caseLog, "utf8")), ...parseStubLog(readFileSync(logPath, "utf8"))];
    const traceArgvs = shell === "zsh" ? parseZshXtrace(readFileSync(xtracePath, "utf8")) : [];
    const seen = new Set(stubArgvs.map((a) => JSON.stringify(a)));
    for (const t of traceArgvs) {
      if (!seen.has(JSON.stringify(t))) {
        stubArgvs.push(t);
        seen.add(JSON.stringify(t));
      }
    }
    runs.push({
      id: item.id,
      shell,
      argvs: stubArgvs,
      timedOut: res.error?.code === "ETIMEDOUT",
      exitCode: res.status,
    });
    rmSync(caseWork, { recursive: true, force: true });
    rmSync(caseTmp, { recursive: true, force: true });
  }
  results.push({ id: item.id, runs });
}
process.stdout.write(JSON.stringify(results));
`;
  writeFileSync(runnerPath, runnerCode, "utf8");

  try {
    const seatbeltAvailable = existsSync(SANDBOX_EXEC);
    const bwrapPath = ["/usr/bin/bwrap", "/bin/bwrap"].find((p) => existsSync(p)) ?? null;
    const backend = resolveSandboxBackend("auto", process.platform, seatbeltAvailable, Boolean(bwrapPath));
    const credentialMask = credentialMaskPaths(homedir());
    let stdout = "";

    if (backend === "macos-seatbelt") {
      // Reuse verification/sandbox.ts Seatbelt policy plus network isolation so oracle runs never touch real remotes.
      const profile = `${buildSeatbeltProfile(workspacePath, tempPath, credentialMask)}\n(deny network*)`;
      stdout = execFileSync(SANDBOX_EXEC, ["-p", profile, process.execPath, runnerPath], {
        cwd: workspacePath,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
      });
    } else {
      const bwrapArgs = buildBubblewrapArgs({
        workspacePath,
        cwd: workspacePath,
        tempPath,
        guardPaths: [],
        credentialMask,
      }).filter((arg) => arg !== "--share-net");
      // Replace the trailing `-c` command invocation with running node runnerPath directly.
      const cut = bwrapArgs.indexOf("--");
      const prefix = bwrapArgs.slice(0, cut + 1);
      stdout = execFileSync(bwrapPath!, [...prefix, process.execPath, runnerPath], {
        cwd: workspacePath,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
      });
    }

    const parsed = JSON.parse(stdout) as Array<{ id: string; runs: OracleRun[] }>;
    const byId = new Map<string, OracleResult>();
    const roleMap = new Map(cases.map((c) => [c.id, c.role ?? "writer"]));
    for (const row of parsed) {
      const role = roleMap.get(row.id) ?? "writer";
      const protectedArgvs: Array<{ shell: OracleShell; argv: string[] }> = [];
      for (const run of row.runs) {
        for (const argv of run.argvs) {
          if (isProtectedArgv(argv, role)) protectedArgvs.push({ shell: run.shell, argv });
        }
      }
      byId.set(row.id, {
        id: row.id,
        runs: row.runs,
        protectedRan: protectedArgvs.length > 0,
        protectedArgvs,
      });
    }
    return byId;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export { parseStubLog, parseZshXtrace };
