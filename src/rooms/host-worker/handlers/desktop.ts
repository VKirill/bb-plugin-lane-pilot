import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "../../contracts";
import { runBrowserQaOnHost } from "../../qa";

export const runBrowserQa: ExperimentalHostRpcHandlers<typeof hostContract>["runBrowserQa"] = async (input) => (
  runBrowserQaOnHost(input)
);

export const probeBrowserQaTarget: ExperimentalHostRpcHandlers<typeof hostContract>["probeBrowserQaTarget"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  let workspaceRealPath: string;
  try {
    workspaceRealPath = await realpath(input.workspacePath);
  } catch {
    throw new Error("browser_qa_workspace_unreachable");
  }
  const target = new URL(input.url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("browser_qa_url_must_be_http_without_userinfo");
  }
  await new Promise<void>((resolve, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send({
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      timeout: 5000,
    }, (res) => {
      res.resume();
      resolve();
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("browser_qa_url_timeout"));
    });
    req.on("error", (cause) => {
      reject(new Error(`browser_qa_url_unreachable:${cause instanceof Error ? cause.message : String(cause)}`));
    });
    req.end();
  });
  return { hostId, workspaceRealPath, url: input.url, processHostId: hostId };
};

/** Where the jev-ultrafast launcher can live on this host: LANE_PILOT_JEV_RUNNER, else the host's toolkit checkout
 *  (~/toolkit, the convention of ~/toolkit/telegram in anamnesis/sources/telegram.ts), else the shared BB-сервис
 *  checkout the owner's machines carry (Mac mini 2026-10). */
export const jevRunnerCandidates = (env: NodeJS.ProcessEnv, home: string): string[] =>
  env.LANE_PILOT_JEV_RUNNER
    ? [env.LANE_PILOT_JEV_RUNNER]
    : [join(home, "toolkit", "computer-use", "bin", "run")];

/**
 * One browser goal through the jev-ultrafast runner, without a shell: the goal is an argument, never shell text.
 * The runner prints its steps and, last, one JSON line {status,url,actions}. Asynchronous, so the host worker keeps
 * serving writer checks while Chrome works.
 */
export const browserGoal: ExperimentalHostRpcHandlers<typeof hostContract>["browserGoal"] = async (input) => {
  const candidates = jevRunnerCandidates(process.env, homedir());
  let runner: string | null = null;
  for (const path of candidates) { if (await lstat(path).then(() => true, () => false)) { runner = path; break; } }
  if (!runner) return { hostId: process.env.BB_HOST_ID ?? input.requestedHostId, exitCode: 127, status: "no_runner", url: null, actions: null, title: null, text: null, log: `jev-ultrafast launcher not found; looked at ${candidates.join(", ")}` };
  const timeoutMs = (input.timeoutSec ?? 180) * 1000;
  const env = { ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":") };
  const { code, out } = await new Promise<{ code: number; out: string }>((resolveRun) => {
    execFile(runner, ["browser", "--url", input.url, "--goal", input.goal], { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const status = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolveRun({ code: status, out: `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}${error && !stdout ? `\n${error.message}` : ""}` });
    });
  });
  let parsed: { status?: unknown; url?: unknown; actions?: unknown; title?: unknown; text?: unknown } = {};
  for (const line of out.trim().split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { parsed = JSON.parse(trimmed) as typeof parsed; break; } catch { continue; }
  }
  return {
    hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
    exitCode: code,
    status: typeof parsed.status === "string" ? parsed.status : code === 0 ? "unknown" : "error",
    url: typeof parsed.url === "string" ? parsed.url : null,
    actions: typeof parsed.actions === "number" ? parsed.actions : null,
    title: typeof parsed.title === "string" ? parsed.title : null,
    text: typeof parsed.text === "string" ? parsed.text : null,
    // The steps only; the final JSON line (with the page text) is returned above, not twice.
    log: out.split("\n").filter((line) => !line.trim().startsWith("{")).join("\n").slice(-2000),
  };
};
