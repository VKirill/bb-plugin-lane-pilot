import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract, QA_DEFAULT_PORTS } from "../../contracts";
import { runBrowserQaOnHost } from "../../qa";

export const runBrowserQa: ExperimentalHostRpcHandlers<typeof hostContract>["runBrowserQa"] = async (input) => (
  runBrowserQaOnHost(input)
);

/** Loopback ports that answer like a web app: a 2xx/3xx reply with an HTML content type, 2 s each, probed in parallel. */
export async function scanBrowserQaPorts(ports: readonly number[]): Promise<string[]> {
  const answers = await Promise.all(ports.map((port) => new Promise<boolean>((resolve) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path: "/", method: "GET", timeout: 2000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400 && /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(String(res.headers["content-type"] ?? "")));
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  })));
  return ports.filter((_, index) => answers[index]).map((port) => `http://127.0.0.1:${port}/`);
}

/** Every default dev-server port that answers as a web app on this host (SMA k_wqa_find: find the app). */
export const findBrowserQaTarget: ExperimentalHostRpcHandlers<typeof hostContract>["findBrowserQaTarget"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  return { hostId, urls: await scanBrowserQaPorts(QA_DEFAULT_PORTS) };
};

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
