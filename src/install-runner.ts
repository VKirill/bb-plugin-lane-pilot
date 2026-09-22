import { spawn } from "node:child_process";
import { join } from "node:path";
import { EXTERNAL_OPS } from "./constants";

export type InstallRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  skippedExternalOps: string[];
};

export function installEnv(input: {
  homeDir: string;
  confirmExternalOps: boolean;
}): { env: NodeJS.ProcessEnv; skippedExternalOps: string[] } {
  const skipped = input.confirmExternalOps ? [] : [...EXTERNAL_OPS];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: input.homeDir,
    LANE_INSTALL_CLAUDE_PLUGIN: input.confirmExternalOps ? "1" : "0",
  };
  if (!input.confirmExternalOps) {
    const path = (env.PATH ?? "").split(":").filter((part) => part.length > 0);
    env.PATH = path.filter((part) => !part.includes("cursor")).join(":") || "/usr/bin:/bin";
    env.LANE_PILOT_SKIP_OPEN_CURSOR = "1";
  }
  return { env, skippedExternalOps: skipped };
}

export function runInstallSh(input: {
  stackRoot: string;
  homeDir: string;
  confirmExternalOps: boolean;
  timeoutMs?: number;
}): Promise<InstallRunResult> {
  const { env, skippedExternalOps } = installEnv(input);
  const script = join(input.stackRoot, "install.sh");
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
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr, skippedExternalOps });
    });
  });
}
