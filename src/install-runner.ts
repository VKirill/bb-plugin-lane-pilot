import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTERNAL_OPS } from "./constants";

export const INSTALL_PHASES = ["npm", "mkdir", "rsync", "settings", "install_json"] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];

export type InstallRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  skippedExternalOps: string[];
  signal: NodeJS.Signals | null;
};

function findOnPath(name: string, exclude: string[] = []): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir || exclude.includes(dir)) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function checkpoint(phase: InstallPhase): string {
  return `
# lane-pilot checkpoint ${phase}
printf '%s\\n' '${phase}' > "$HOME/.lane-pilot-phase"
if [[ "\${LANE_INSTALL_CLAUDE_PLUGIN:-1}" == "0" && "${phase}" == "npm" ]]; then
  printf '%s\\n' 'не применимо без подтверждения' > "$HOME/.lane-pilot-npm-skipped"
fi
if [[ "\${LANE_PILOT_STOP_AFTER:-}" == "${phase}" ]]; then
  kill -9 "\${LANE_PILOT_EXECUTOR_PID:-}" "$$" 2>/dev/null || true
  kill -9 $$
fi
`;
}

const ANCHORS: Array<{ phase: InstallPhase; anchor: string }> = [
  {
    phase: "npm",
    anchor: "    open-cursor install || echo \"warning: open-cursor install failed; Cursor models stay unavailable in OpenCode\" >&2\n  fi\nfi\n",
  },
  {
    phase: "mkdir",
    anchor: "mkdir -p \"$CODEX\"\n",
  },
  {
    phase: "rsync",
    anchor: "rsync -a \"${RSYNC_FILTERS[@]}\" \"$STACK_ROOT/schemas/\" \"$DEST/schemas/\"\n",
  },
  {
    phase: "settings",
    anchor: "python3 \"$DEST/hooks/merge_claude_settings.py\" \\\n  \"$CLAUDE/settings.json\" \"$DEST/hooks/guard_shell.py\" \\\n  --statusline \"$DEST/bin/lane-statusline\" \\\n  --session-mark \"$DEST/hooks/lane_statusline_session.py\" \\\n  \"${MERGE_PLUGIN_ARGS[@]}\"\n",
  },
  {
    phase: "install_json",
    anchor: "    \"source_dirty\": source_dirty == \"true\",\n}, indent=2, sort_keys=True) + \"\\n\", encoding=\"utf-8\")\nos.replace(temporary, path)\nPY\n",
  },
];

export async function instrumentInstallSh(stackRoot: string, destPath: string): Promise<void> {
  let text = await readFile(join(stackRoot, "install.sh"), "utf8");
  text = text.replace(
    'STACK_ROOT="$(cd "$(dirname "$0")" && pwd)"',
    `STACK_ROOT="${stackRoot}"`,
  );
  for (const { phase, anchor } of ANCHORS) {
    const index = text.indexOf(anchor);
    if (index < 0) throw new Error(`install.sh is missing ${phase} checkpoint anchor`);
    const at = index + anchor.length;
    text = `${text.slice(0, at)}${checkpoint(phase)}${text.slice(at)}`;
  }
  await writeFile(destPath, text, { mode: 0o755 });
}

export async function writeSkipWrappers(dir: string, skipLog: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const realNpm = findOnPath("npm", [dir]) ?? "/usr/bin/npm";
  await writeFile(join(dir, "npm"), `#!/bin/bash
set -euo pipefail
case " $* " in
  *" @rama_nigg/open-cursor "*|*" @rama_nigg/open-cursor@"*)
    printf '%s\\n' "blocked npm $*" >> ${JSON.stringify(skipLog)}
    echo "lane-pilot: skipped npm install -g @rama_nigg/open-cursor (confirmExternalOps=false)" >&2
    exit 0
    ;;
esac
exec ${JSON.stringify(realNpm)} "$@"
`, { mode: 0o755 });
  await writeFile(join(dir, "open-cursor"), `#!/bin/bash
printf '%s\\n' "blocked open-cursor $*" >> ${JSON.stringify(skipLog)}
echo "lane-pilot: skipped open-cursor (confirmExternalOps=false)" >&2
exit 0
`, { mode: 0o755 });
  await chmod(join(dir, "npm"), 0o755);
  await chmod(join(dir, "open-cursor"), 0o755);
}

export function installEnv(input: {
  homeDir: string;
  confirmExternalOps: boolean;
  wrapperDir?: string;
  executorPid?: number;
  stopAfterPhase?: InstallPhase;
}): { env: NodeJS.ProcessEnv; skippedExternalOps: string[] } {
  const skipped = input.confirmExternalOps ? [] : [...EXTERNAL_OPS];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: input.homeDir,
    LANE_INSTALL_CLAUDE_PLUGIN: input.confirmExternalOps ? "1" : "0",
  };
  if (input.executorPid) env.LANE_PILOT_EXECUTOR_PID = String(input.executorPid);
  if (input.stopAfterPhase) env.LANE_PILOT_STOP_AFTER = input.stopAfterPhase;
  if (!input.confirmExternalOps && input.wrapperDir) {
    env.PATH = `${input.wrapperDir}:${env.PATH ?? "/usr/bin:/bin"}`;
    env.LANE_PILOT_SKIP_OPEN_CURSOR = "1";
  }
  return { env, skippedExternalOps: skipped };
}

export async function runInstallSh(input: {
  stackRoot: string;
  homeDir: string;
  confirmExternalOps: boolean;
  timeoutMs?: number;
  stopAfterPhase?: InstallPhase;
  executorPid?: number;
}): Promise<InstallRunResult> {
  const wrapperDir = join(input.homeDir, ".agents/lane-pilot/bin-wrappers");
  const skipLog = join(input.homeDir, ".agents/lane-pilot/skipped-external-ops.log");
  if (!input.confirmExternalOps) await writeSkipWrappers(wrapperDir, skipLog);
  await mkdir(join(input.homeDir, ".agents/lane-pilot"), { recursive: true });
  let script = join(input.stackRoot, "install.sh");
  if (input.stopAfterPhase) {
    script = join(input.homeDir, ".agents/lane-pilot/instrumented-install.sh");
    await instrumentInstallSh(input.stackRoot, script);
  }
  const { env, skippedExternalOps } = installEnv({
    ...input,
    wrapperDir: input.confirmExternalOps ? undefined : wrapperDir,
    executorPid: input.executorPid ?? process.pid,
  });
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      cwd: input.stackRoot,
      env,
      timeout: input.timeoutMs ?? 10 * 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout,
        stderr,
        skippedExternalOps,
        signal,
      });
    });
  });
}
