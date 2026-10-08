import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

export const SKIP_WRAPPER_NAMES = ["npm", "npx", "open-cursor"] as const;

export function isolatedNpmPrefix(homeDir: string): string {
  return join(homeDir, ".agents/lane-pilot/npm-prefix");
}

function checkpoint(phase: InstallPhase): string {
  return `
# lane-pilot checkpoint ${phase}
printf '%s\\n' '${phase}' > "$HOME/.lane-pilot-phase"
if [[ "\${LANE_INSTALL_CLAUDE_PLUGIN:-1}" == "0" && "${phase}" == "npm" ]]; then
  printf '%s\\n' 'не применимо без подтверждения' > "$HOME/.lane-pilot-npm-skipped"
fi
if [[ -n "\${LANE_PILOT_SNAPSHOT_MANIFEST:-}" ]]; then
python3 - "\${LANE_PILOT_SNAPSHOT_MANIFEST}" <<'PY'
import hashlib, json, os, stat, sys, tempfile

manifest_path = sys.argv[1]
with open(manifest_path, "r", encoding="utf-8") as stream:
    manifest = json.load(stream)

def file_sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def tree_sha(root):
    digest = hashlib.sha256()
    def walk(directory, relative):
        for name in sorted(os.listdir(directory), key=os.fsencode):
            absolute = os.path.join(directory, name)
            rel = os.path.join(relative, name) if relative else name
            info = os.lstat(absolute)
            if stat.S_ISLNK(info.st_mode):
                digest.update(("L:" + rel + "->" + os.readlink(absolute) + "\\n").encode())
            elif stat.S_ISDIR(info.st_mode):
                digest.update(("D:" + rel + "\\n").encode())
                walk(absolute, rel)
            elif stat.S_ISREG(info.st_mode):
                digest.update(("F:" + rel + ":" + file_sha(absolute) + "\\n").encode())
    walk(root, "")
    return digest.hexdigest()

for entry in manifest["entries"]:
    if entry["kind"] == "external":
        continue
    path = entry["path"]
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        entry["sha256After"] = None
        continue
    if stat.S_ISLNK(info.st_mode):
        entry["sha256After"] = hashlib.sha256(os.readlink(path).encode()).hexdigest()
    elif stat.S_ISREG(info.st_mode):
        entry["sha256After"] = file_sha(path)
    elif stat.S_ISDIR(info.st_mode):
        entry["sha256After"] = tree_sha(path)
    else:
        entry["sha256After"] = None

folder = os.path.dirname(manifest_path)
fd, temporary = tempfile.mkstemp(prefix=".manifest-checkpoint-", dir=folder)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(manifest, stream, indent=2)
        stream.write("\\n")
    os.replace(temporary, manifest_path)
except BaseException:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
    raise
PY
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
  for (const name of SKIP_WRAPPER_NAMES) {
    await writeFile(join(dir, name), `#!/bin/bash
printf '%s\\n' "blocked ${name} $*" >> ${JSON.stringify(skipLog)}
echo "lane-pilot: skipped ${name} (confirmExternalOps=false; real npm is never invoked)" >&2
exit 0
`, { mode: 0o755 });
    await chmod(join(dir, name), 0o755);
  }
}

const INSTALL_ENV_BY_KEY: Record<string, string> = {
  "install.LANE_INSTALL_LOCAL_MARKETPLACE": "LANE_INSTALL_LOCAL_MARKETPLACE",
  "install.LANE_INSTALL_CLAUDE_PLUGIN": "LANE_INSTALL_CLAUDE_PLUGIN",
  "install.CLAUDE_CONFIG_DIR": "CLAUDE_CONFIG_DIR",
  "install.CODEX_HOME": "CODEX_HOME",
};

function asEnvText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

export function applyInstallSettings(
  env: NodeJS.ProcessEnv,
  settings: Record<string, unknown> | undefined,
  confirmExternalOps: boolean,
): string[] {
  const applied: string[] = [];
  if (!settings) return applied;
  for (const [key, name] of Object.entries(INSTALL_ENV_BY_KEY)) {
    if (!(key in settings)) continue;
    const text = asEnvText(settings[key]);
    if (text === null) continue;
    if (name === "LANE_INSTALL_CLAUDE_PLUGIN" && !confirmExternalOps) continue;
    env[name] = text;
    applied.push(key);
  }
  return applied;
}

export function installEnv(input: {
  homeDir: string;
  confirmExternalOps: boolean;
  wrapperDir?: string;
  npmPrefix?: string;
  pathOverride?: string;
  executorPid?: number;
  stopAfterPhase?: InstallPhase;
  settings?: Record<string, unknown>;
}): { env: NodeJS.ProcessEnv; skippedExternalOps: string[]; applied: string[] } {
  const skipped = input.confirmExternalOps ? [] : [...EXTERNAL_OPS];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: input.homeDir,
    LANE_INSTALL_CLAUDE_PLUGIN: input.confirmExternalOps ? "1" : "0",
  };
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  if (input.executorPid) env.LANE_PILOT_EXECUTOR_PID = String(input.executorPid);
  if (input.stopAfterPhase) env.LANE_PILOT_STOP_AFTER = input.stopAfterPhase;
  if (!input.confirmExternalOps) {
    const prefix = input.npmPrefix ?? isolatedNpmPrefix(input.homeDir);
    env.npm_config_prefix = prefix;
    env.NPM_CONFIG_PREFIX = prefix;
    env.LANE_PILOT_SKIP_OPEN_CURSOR = "1";
    const rest = input.pathOverride ?? env.PATH ?? "/usr/bin:/bin";
    if (input.wrapperDir) {
      env.PATH = `${input.wrapperDir}:${rest}`;
    } else {
      env.PATH = rest;
    }
  }
  const applied = applyInstallSettings(env, input.settings, input.confirmExternalOps);
  return { env, skippedExternalOps: skipped, applied };
}

export async function runInstallSh(input: {
  stackRoot: string;
  homeDir: string;
  confirmExternalOps: boolean;
  timeoutMs?: number;
  stopAfterPhase?: InstallPhase;
  executorPid?: number;
  settings?: Record<string, unknown>;
  snapshotManifestPath?: string;
}): Promise<InstallRunResult> {
  const wrapperDir = join(input.homeDir, ".agents/lane-pilot/bin-wrappers");
  const skipLog = join(input.homeDir, ".agents/lane-pilot/skipped-external-ops.log");
  const npmPrefix = isolatedNpmPrefix(input.homeDir);
  await mkdir(join(input.homeDir, ".agents/lane-pilot"), { recursive: true });
  if (!input.confirmExternalOps) {
    await mkdir(npmPrefix, { recursive: true });
    await writeSkipWrappers(wrapperDir, skipLog);
  }
  const script = join(input.homeDir, `.agents/lane-pilot/instrumented-install-${randomUUID()}.sh`);
  await instrumentInstallSh(input.stackRoot, script);
  const { env, skippedExternalOps } = installEnv({
    ...input,
    wrapperDir: input.confirmExternalOps ? undefined : wrapperDir,
    npmPrefix: input.confirmExternalOps ? undefined : npmPrefix,
    pathOverride: input.confirmExternalOps ? undefined : process.env.LANE_PILOT_SAFE_PATH,
    executorPid: input.executorPid ?? process.pid,
  });
  if (input.snapshotManifestPath) env.LANE_PILOT_SNAPSHOT_MANIFEST = input.snapshotManifestPath;
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
    child.on("error", async (error) => {
      await rm(script, { force: true }).catch(() => undefined);
      reject(error);
    });
    child.on("close", (code, signal) => {
      void rm(script, { force: true }).then(() => resolve({
          exitCode: code ?? (signal ? 1 : 0),
          stdout,
          stderr,
          skippedExternalOps,
          signal,
        }), () => resolve({
          exitCode: code ?? (signal ? 1 : 0),
          stdout,
          stderr,
          skippedExternalOps,
          signal,
        }));
    });
  });
}
