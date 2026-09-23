import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "./contracts";
import { inventoryCoexistence, runCoexistenceOperation } from "./coexistence";
import { runBrowserQaOnHost } from "./stages/browser-qa";
import { runCliOnHost, runCommandOnHost, writePmSettingsOnHost } from "./cli-run";
import {
  connectOpencodeStack,
  detectStack,
  importConfigStack,
  installStack,
  rollbackStack,
  snapshotStack,
  type HostContext,
} from "./stack-ops";

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function ctx(input: {
  requestedHostId: string;
  workspacePath?: string;
  threadStoragePath?: string;
  receiptDir?: string;
  confirmExternalOps?: boolean;
  localFallbackPath?: string;
  guardSourcePath?: string;
  pmWorkspacePath?: string;
  projectId?: string;
  snapshotPath?: string;
}): HostContext {
  return { ...input, moduleUrl: import.meta.url };
}

export const coexistenceInventory: ExperimentalHostRpcHandlers<typeof hostContract>["coexistenceInventory"] = async (input) => (
  inventoryCoexistence({ projectId: input.projectId, hostId: input.requestedHostId, targetSha: input.targetSha })
);

export const coexistenceOperation: ExperimentalHostRpcHandlers<typeof hostContract>["coexistenceOperation"] = async (input) => (
  runCoexistenceOperation({
    projectId: input.projectId,
    hostId: input.requestedHostId,
    operation: input.operation,
    manager: input.manager,
    path: input.path,
    expectedSha256: input.expectedSha256,
    snapshotId: input.snapshotId,
    targetSha: input.targetSha,
    confirmExternalOps: input.confirmExternalOps,
  })
);

export const detect: ExperimentalHostRpcHandlers<typeof hostContract>["detect"] = async (input) => (
  detectStack(ctx(input))
);

export const snapshot: ExperimentalHostRpcHandlers<typeof hostContract>["snapshot"] = async (input) => (
  snapshotStack(ctx(input))
);

export const install: ExperimentalHostRpcHandlers<typeof hostContract>["install"] = async (input) => (
  installStack(ctx(input))
);

export const rollback: ExperimentalHostRpcHandlers<typeof hostContract>["rollback"] = async (input) => (
  rollbackStack(ctx(input))
);

export const importConfig: ExperimentalHostRpcHandlers<typeof hostContract>["importConfig"] = async (input) => (
  importConfigStack(ctx(input))
);

export const connectOpencode: ExperimentalHostRpcHandlers<typeof hostContract>["connectOpencode"] = async (input) => (
  connectOpencodeStack(ctx(input))
);

export const runCli: ExperimentalHostRpcHandlers<typeof hostContract>["runCli"] = async (input) => (
  runCliOnHost(input)
);

export const runCommand: ExperimentalHostRpcHandlers<typeof hostContract>["runCommand"] = async (input) => (
  runCommandOnHost(input)
);

export const runBrowserQa: ExperimentalHostRpcHandlers<typeof hostContract>["runBrowserQa"] = async (input) => (
  runBrowserQaOnHost(input)
);

const PLAN_EFFORT_QUESTION = {
  type:"choice",
  instructions:"Reasoning effort this turn needs. Pick the cheapest that still solves the task.",
  criteria:{
    low:"obvious, mechanical, follow an existing pattern; extra thinking is waste",
    medium:"normal implementation with local scope",
    high:"must think carefully; many tradeoffs or failure modes",
    xhigh:"deep architecture, concurrency, security, or wide blast radius; cheaper effort will miss it",
  },
} as const;

async function jevApiKey(): Promise<string> {
  const fromEnv = (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const text = await readFile(`${homedir()}/secrets/typesafe.env`, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const name = trimmed.slice(0, eq);
      if (name !== "TYPESAFE_API_KEY" && name !== "JEV_API_KEY") continue;
      const value = trimmed.slice(eq + 1).trim().replace(/^['\"]|['\"]$/g, "");
      if (value) return value;
    }
  } catch { /* report disabled below */ }
  return "";
}

export const classifyPlan: ExperimentalHostRpcHandlers<typeof hostContract>["classifyPlan"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const planSha256 = createHash("sha256").update(input.plan, "utf8").digest("hex");
  const sourceLength = Buffer.byteLength(input.plan, "utf8");
  const payload = { model:"jev-latest", state:{ task:input.plan }, questions:{ effort:PLAN_EFFORT_QUESTION } };
  const body = JSON.stringify(payload);
  const decodedPlan = (JSON.parse(body) as { state:{ task:string } }).state.task;
  const sentPlanSha256 = createHash("sha256").update(decodedPlan, "utf8").digest("hex");
  const sentLength = Buffer.byteLength(decodedPlan, "utf8");
  const transportProof = { planSha256, sentPlanSha256, sourceLength, sentLength };
  if (sentPlanSha256 !== planSha256 || sentLength !== sourceLength) {
    return { hostId, status:"error", effort:null, reason:"plan_serialization_mismatch", ...transportProof };
  }
  const apiKey = await jevApiKey();
  if (!apiKey) return { hostId, status:"disabled", effort:null, reason:"missing_typesafe_api_key",
    planSha256, sentPlanSha256:null, sourceLength, sentLength:null };
  try {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method:"POST",
      headers:{ authorization:`Bearer ${apiKey}`, "content-type":"application/json" },
      body,
      signal:AbortSignal.timeout(2500),
    });
    if (!response.ok) return { hostId, status:"error", effort:null, reason:`http_${response.status}`, ...transportProof };
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("answers" in value)) {
      return { hostId, status:"error", effort:null, reason:"invalid_response", ...transportProof };
    }
    const answers = (value as { answers?: unknown }).answers;
    const effort = answers && typeof answers === "object"
      ? (answers as Record<string, { choice?: unknown }>).effort?.choice
      : undefined;
    if (typeof effort !== "string") return { hostId, status:"error", effort:null, reason:"missing_effort_answer", ...transportProof };
    return { hostId, status:"ok", effort, reason:null, ...transportProof };
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "api_request_failed";
    return { hostId, status:reason === "timeout" ? "timeout" : "error", effort:null, reason, ...transportProof };
  }
};

export const writePmSettings: ExperimentalHostRpcHandlers<typeof hostContract>["writePmSettings"] = async (input) => (
  writePmSettingsOnHost(input)
);

export const snapshotDryRun: ExperimentalHostRpcHandlers<typeof hostContract>["snapshotDryRun"] = async (input) => ({
  hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
  entries: await Promise.all(input.paths.map(async (path) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return { path, kind:"symlink" as const, sha256:null, symlinkTarget:await readlink(path) };
      if (info.isFile()) return { path, kind:"file" as const, sha256:await hashFile(path), symlinkTarget:null };
      if (info.isDirectory()) return { path, kind:"directory" as const, sha256:null, symlinkTarget:null };
      return { path, kind:"other" as const, sha256:null, symlinkTarget:null };
    } catch {
      return { path, kind:"missing" as const, sha256:null, symlinkTarget:null };
    }
  })),
});
