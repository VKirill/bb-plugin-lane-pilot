import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

export const browserQaInputSchema = z.object({
  requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), url:z.string().url(),
  slug:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), cases:z.array(z.string().min(1).max(2000)).min(1).max(30),
  envClass:z.enum(["local","staging","preview","production","unknown"]), viewports:z.string().regex(/^\d{2,4}(,\d{2,4}){0,2}$/),
  authorized:z.boolean(), provider:z.enum(["jev","codex"]), model:z.string().max(120).optional(),
  reasoningEffort:z.enum(["low","medium","high","xhigh","max"]).optional(),
  backend:z.enum(["live-chrome","chrome-qa","headless"]), timeoutSec:z.number().int().min(30).max(1800),
}).strict();

export type BrowserQaInput = z.infer<typeof browserQaInputSchema>;

export type BrowserQaResult = {
  hostId:string; provider:"jev"|"codex"; runner:string; exitCode:number; verdict:"passed"|"failed"|"blocked";
  actualModel:string|null; actualReasoningEffort:string|null; actualBackend:string|null;
  reportPath:string|null; reportSha256:string|null; reportText:string|null;
  artifacts:Array<{path:string; sha256:string; size:number}>; stdout:string; stderr:string; reason:string|null;
};

function sha256(data:Buffer|string):string {
  return createHash("sha256").update(data).digest("hex");
}

function redact(text:string):string {
  return text
    .replace(/(\b(?:authorization|cookie|set-cookie|token|password|otp|api[_-]?key)\b\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
}

export function browserQaVerdict(text:string, exitCode:number):BrowserQaResult["verdict"] {
  const summary = text.match(/Total\s*\/\s*Passed\s*\/\s*Failed\s*\/\s*Blocked(?:\s*\/\s*Pending)?\s*:\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?/i);
  if (!summary) return "blocked";
  const total = Number(summary[1]);
  const passed = Number(summary[2]);
  const failed = Number(summary[3]);
  const blocked = Number(summary[4]);
  const pending = summary[5] == null ? total - passed - failed - blocked : Number(summary[5]);
  if (pending < 0 || passed + failed + blocked + pending !== total) return "blocked";
  if (failed > 0 || exitCode !== 0) return "failed";
  if (blocked > 0 || pending > 0 || total === 0 || passed !== total) return "blocked";
  return "passed";
}

function hasPotentialSideEffect(cases:string[]):boolean {
  const english = /\b(submit|purchase|pay|delete|send|grant permission|revoke permission|create|update|save|publish|upload|download|change|confirm)\b/i;
  const russian = /удал|отправ|созда|оплат|куп|сохран|публику|подтверд|выда|отоз|измен|обнов|загруз|скача/i;
  return cases.some((item) => english.test(item) || russian.test(item));
}

async function collectArtifacts(root:string, dir:string, limit=100):Promise<Array<{path:string; sha256:string; size:number}>> {
  const rootReal = await realpath(root);
  const results:Array<{path:string; sha256:string; size:number}> = [];
  const visit = async (current:string):Promise<void> => {
    const entries = await readdir(current, { withFileTypes:true });
    for (const entry of entries) {
      if (results.length >= limit) return;
      const full = join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error("browser_qa_output_contains_symlink");
      if (info.isDirectory()) { await visit(full); continue; }
      if (!info.isFile()) continue;
      const real = await realpath(full);
      const rel = relative(rootReal, real);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("browser_qa_artifact_escaped_project");
      const bytes = await readFile(full);
      results.push({ path:rel.split("\\").join("/"), sha256:sha256(bytes), size:bytes.byteLength });
    }
  };
  await visit(dir);
  return results;
}

export async function runBrowserQaOnHost(raw:BrowserQaInput):Promise<BrowserQaResult> {
  const input = browserQaInputSchema.parse(raw);
  const target = new URL(input.url);
  if (!["http:","https:"].includes(target.protocol) || target.username || target.password) throw new Error("browser_qa_url_must_be_http_without_userinfo");
  const sideEffectCase = hasPotentialSideEffect(input.cases);
  if ((input.envClass === "production" || input.envClass === "unknown" || sideEffectCase) && !input.authorized) {
    throw new Error("browser_qa_requires_explicit_authorization_for_target_or_side_effect");
  }
  const project = await realpath(input.projectCwd);
  const agentsDir = join(project, ".agents");
  const qaDir = join(agentsDir, "qa");
  const outputDir = join(qaDir, input.slug);
  for (const path of [agentsDir, qaDir, outputDir]) {
    let info;
    try {
      info = await lstat(path);
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
    if (info.isSymbolicLink()) throw new Error("browser_qa_output_path_is_symlink");
    if (path === outputDir) throw new Error("browser_qa_slug_already_exists");
    if (!info.isDirectory()) throw new Error("browser_qa_output_parent_not_directory");
  }
  const runner = input.provider === "jev" ? "browser-qa-jev" : "browser-qa-codex";
  const binary = join(homedir(), ".agents", "bin", runner);
  await access(binary).catch(() => { throw new Error(`browser_qa_runner_unavailable:${runner}`); });
  const argv = ["--project-cwd", project, "--url", input.url, "--slug", input.slug,
    "--env-class", input.envClass, "--viewports", input.viewports, "--backend", input.backend];
  for (const item of input.cases) argv.push("--case", item);
  if (input.authorized) argv.push("--authorized");
  if (input.provider === "codex") {
    if (!input.model) throw new Error("browser_qa_codex_requires_configured_model");
    argv.push("--model", input.model);
    if (input.reasoningEffort) argv.push("--reasoning-effort", input.reasoningEffort);
  }
  const completed = spawnSync(binary, argv, { cwd:project, encoding:"utf8", timeout:input.timeoutSec * 1000, maxBuffer:4_000_000 });
  const exitCode = completed.status ?? 1;
  let artifacts:Array<{path:string; sha256:string; size:number}> = [];
  let reportText:string|null = null;
  let reportPath:string|null = null;
  let reportSha256:string|null = null;
  let actualModel:string|null = null;
  let actualReasoningEffort:string|null = null;
  let actualBackend:string|null = null;
  try {
    const rootReal = await realpath(project);
    const outputReal = await realpath(outputDir);
    const rel = relative(rootReal, outputReal);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("browser_qa_output_escaped_project");
    artifacts = await collectArtifacts(project, outputReal);
    const receiptName = input.provider === "jev" ? "jev-run.json" : "codex-run.json";
    const runnerReceipt = artifacts.find((item) => item.path === `.agents/qa/${input.slug}/${receiptName}`);
    if (runnerReceipt) {
      const rawReceipt:unknown = JSON.parse((await readFile(join(outputReal,receiptName))).toString("utf8"));
      if (rawReceipt && typeof rawReceipt === "object") {
        const record = rawReceipt as Record<string,unknown>;
        actualModel = typeof record.model === "string" ? record.model : null;
        actualReasoningEffort = typeof record.reasoning_effort === "string" ? record.reasoning_effort : null;
        actualBackend = typeof record.backend === "string" ? record.backend : null;
      }
    }
    const report = artifacts.find((item) => item.path === `.agents/qa/${input.slug}/REPORT.md`);
    if (report) {
      reportPath = report.path;
      reportSha256 = report.sha256;
      const reportBytes = await readFile(join(outputReal, "REPORT.md"));
      reportText = redact(reportBytes.toString("utf8").slice(0, 24_000));
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (exitCode === 0) return { hostId:process.env.BB_HOST_ID ?? input.requestedHostId, provider:input.provider, runner, exitCode,
      verdict:"blocked", actualModel, actualReasoningEffort, actualBackend, reportPath:null, reportSha256:null, reportText:null, artifacts, stdout:redact(completed.stdout ?? ""),
      stderr:redact(completed.stderr ?? ""), reason:message };
  }
  return {
    hostId:process.env.BB_HOST_ID ?? input.requestedHostId, provider:input.provider, runner, exitCode,
    verdict:reportText ? browserQaVerdict(reportText, exitCode) : "blocked", actualModel, actualReasoningEffort, actualBackend, reportPath, reportSha256, reportText,
    artifacts, stdout:redact((completed.stdout ?? "").slice(0, 12_000)), stderr:redact((completed.stderr ?? "").slice(0, 12_000)),
    reason:reportText ? null : "browser_qa_report_missing",
  };
}
